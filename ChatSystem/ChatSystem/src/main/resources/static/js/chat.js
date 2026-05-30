/* ==============================================
   ChatRoom — chat.js
   ============================================== */

/* ---- CSRF Protection ----
 * Spring Security writes the XSRF-TOKEN cookie (HttpOnly=false).
 * We attach it as X-XSRF-TOKEN on every non-GET AJAX request.
 * This single global hook covers all $.ajax / $.post / $.get calls.
 */
(function setupCsrf() {
  function getCsrfToken() {
    var match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
  $.ajaxSetup({
    beforeSend: function (xhr, settings) {
      var method = (settings.type || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        xhr.setRequestHeader("X-XSRF-TOKEN", getCsrfToken());
      }
    },
  });
})();

var stompClient = null;
var currentUsername = null;
var selectedUser = "public";
/** When non-null we are chatting in this group ({@code selectedUser} holds {@code '__none__'} as a placeholder). */
var activeGroupId = null;
var contactsCache = [];
var MAX_MESSAGE_LENGTH = 10000;
var contextMenuTargetId = null;
var contextMenuTargetRow = null;
var rightPanelState = {
  tab: "info",
  context: "public",
  manageExpanded: false,
  manageGroupId: null,
};
var unreadCounts = {
  private: {},
  groups: {},
};

// Reply state
var replyToId = null;
var replyToContent = null;
var replyToSender = null;

// Thread panel state
var threadPanelOpen = false;
var currentThreadRootId = null;

// Voice recording state
var mediaRecorder = null;
var audioChunks = [];
var isRecording = false;
var recordingTimer = null;
var recordingSeconds = 0;
var activeAudioStream = null;

/* ---- Avatar helpers ---- */
function getInitial(name) {
  return name && name.length > 0 ? name.charAt(0).toUpperCase() : "?";
}
function escapeHtml(str) {
  if (!str) return "";
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
function getAvatarColor(name) {
  var colors = [
    "#2563eb",
    "#7c3aed",
    "#db2777",
    "#059669",
    "#d97706",
    "#dc2626",
    "#0891b2",
    "#9333ea",
  ];
  var idx = 0;
  if (name) {
    for (var i = 0; i < name.length; i++) idx += name.charCodeAt(i);
  }
  return colors[idx % colors.length];
}

/* ============================================
   DELETE MODAL HELPERS
   ============================================ */
var _deleteModalTrigger = null; // element that opened the modal

function openDeleteConfirmModal(messageId, isBulk, bulkCount) {
  _deleteModalTrigger = document.activeElement;
  var text = isBulk
    ? "Delete " + bulkCount + " selected messages? This cannot be undone."
    : "Delete this message? This cannot be undone.";
  $("#delete-confirm-text").text(text);
  $("#delete-confirm-modal").data("message-id", messageId);
  $("#delete-confirm-modal").data("is-bulk", isBulk ? "1" : "0");
  $("#delete-confirm-modal").css("display", "flex");
  $("#delete-confirm-ok").trigger("focus");
}

function closeDeleteConfirmModal() {
  $("#delete-confirm-modal").css("display", "none");
  if (_deleteModalTrigger) {
    _deleteModalTrigger.focus();
    _deleteModalTrigger = null;
  }
}

function openDeleteForMeModal(messageId) {
  _deleteModalTrigger = document.activeElement;
  $("#delete-for-me-modal").data("message-id", messageId);
  $("#delete-for-me-modal").css("display", "flex");
  $("#delete-for-me-ok").trigger("focus");
}

function closeDeleteForMeModal() {
  $("#delete-for-me-modal").css("display", "none");
  if (_deleteModalTrigger) {
    _deleteModalTrigger.focus();
    _deleteModalTrigger = null;
  }
}

function trapFocusInModal(e, modalEl) {
  if (e.key !== "Tab") return;
  var focusable = $(modalEl)
    .find(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    .filter(":visible")
    .toArray();
  if (focusable.length === 0) return;
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/* ==============================================
   UNREAD MESSAGE BADGES
   ============================================== */
function incrementUnreadCount(type, id) {
  if (type === "private") {
    unreadCounts.private[id] = (unreadCounts.private[id] || 0) + 1;
    updateUnreadBadge("private", id);
  } else if (type === "group") {
    unreadCounts.groups[id] = (unreadCounts.groups[id] || 0) + 1;
    updateUnreadBadge("group", id);
  }
}

function updateUnreadBadge(type, id) {
  var badgeId =
    type === "private" ? "unread-badge-" + id : "unread-badge-group-" + id;
  var count =
    type === "private" ? unreadCounts.private[id] : unreadCounts.groups[id];
  var badgeEl = $("#" + badgeId);

  if (count > 0) {
    var displayCount = count > 99 ? "99+" : count;
    if (badgeEl.length === 0) {
      // Create badge if it doesn't exist
      var contactItem =
        type === "private"
          ? $("#contact-item-" + id)
          : $("#contact-group-" + id);
      if (contactItem.length > 0) {
        var avatar = contactItem.find(".cr-contact-avatar");
        avatar.after(
          '<div class="cr-unread-badge" id="' +
            badgeId +
            '">' +
            displayCount +
            "</div>",
        );
      }
    } else {
      badgeEl.text(displayCount).show();
    }
  } else {
    badgeEl.hide();
  }
}

function clearUnreadCount(type, id) {
  if (type === "private") {
    unreadCounts.private[id] = 0;
  } else if (type === "group") {
    unreadCounts.groups[id] = 0;
  }
  updateUnreadBadge(type, id);
}
function makeAvatarCircle(name, size, fontSize) {
  size = size || 36;
  fontSize = fontSize || 14;
  return (
    '<div style="width:' +
    size +
    "px;height:" +
    size +
    "px;border-radius:50%;background:" +
    getAvatarColor(name) +
    ";display:flex;align-items:center;justify-content:center;" +
    "color:#fff;font-weight:700;font-size:" +
    fontSize +
    'px;flex-shrink:0;">' +
    getInitial(name) +
    "</div>"
  );
}

/* ==============================================
   SEND BUTTON MODE
   ============================================== */
function updateSendBtnMode() {
  if (isRecording) return;
  var text = $("#messageInput").val().trim();
  var isGroup = activeGroupId != null;
  var isPublic = selectedUser === "public";

  if (text.length === 0 && !isPublic && !isGroup) {
    // Mic mode
    $("#sendButton").addClass("mic-mode").attr("title", "Record voice message");
    $("#sendBtnIcon")
      .removeClass("fi-sr-paper-plane fi-sr-square")
      .addClass("fi-sr-microphone");
  } else {
    // Send message mode
    $("#sendButton").removeClass("mic-mode").attr("title", "Send");
    $("#sendBtnIcon")
      .removeClass("fi-sr-microphone fi-sr-square")
      .addClass("fi-sr-paper-plane");
  }
}

/* ==============================================
   INIT
   ============================================== */
$(document).ready(function () {
  currentUsername = $("#currentUsername").attr("content");
  if (currentUsername) {
    connect();
    fetchContacts();
    loadChatHistory("public");
    updateHeaderAvatar("Public Chat Room");
  }

  $("#messageInput").on("keypress", function (e) {
    if (e.which === 13) sendMessage();
  });

  // Contact search filter
  $("#contactSearch").on("input", function () {
    var q = $(this).val().toLowerCase();
    $("#onlineUsersList .cr-contact-item:not(.public-chat-item)").each(
      function () {
        var name = $(this).find(".cr-contact-name").text().toLowerCase();
        $(this).toggle(name.includes(q));
      },
    );
  });

  initSidebarResize();
  initTooltip();

  // Mobile sidebar toggle
  $("#mobileSidebarToggle").on("click", function (e) {
    e.stopPropagation();
    $("#chat-sidebar").toggleClass("mobile-open");
  });

  // Close sidebar on clicking outside in mobile view
  $("#chat-body").on("click", function (e) {
    if (
      window.innerWidth <= 768 &&
      !$(e.target).closest("#chat-sidebar").length &&
      !$(e.target).closest("#mobileSidebarToggle").length
    ) {
      $("#chat-sidebar").removeClass("mobile-open");
    }
  });

  // Right Sidebar Events
  $("#topbarUserInfo, .info-btn, #toggle-right-sidebar").on(
    "click",
    function () {
      closeThreadPanel();
      $("#right-sidebar").toggleClass("open");
      if (window.innerWidth <= 768) {
        $("#right-sidebar-backdrop").toggleClass("show");
      }
      if ($("#right-sidebar").hasClass("open")) {
        updateRightSidebarInfo();
      }
    },
  );
  $("#rightSidebarClose, #right-sidebar-backdrop").on("click", function () {
    $("#right-sidebar").removeClass("open");
    $("#right-sidebar-backdrop").removeClass("show");
  });

  // Thread Panel Events
  $("#threadPanelClose").on("click", closeThreadPanel);

  $("#threadInput").on("keypress", function (e) {
    if (e.which === 13) {
      sendThreadReply();
    }
  });

  $("#threadSendBtn").on("click", sendThreadReply);

  $("#rpTabInfo, #rpTabSearch, #rpTabGallery").on("click", function () {
    setRightPanelTab($(this).data("tab"));
  });

  $("#rightGroupManageToggle").on("click", function () {
    rightPanelState.manageExpanded = !rightPanelState.manageExpanded;
    applyGroupManageExpandedState();
  });

  $("#chatSearchInput").on("input", function () {
    runRightPanelSearch($(this).val());
  });

  // Request Notification permission
  if ("Notification" in window) {
    if (
      Notification.permission !== "granted" &&
      Notification.permission !== "denied"
    ) {
      Notification.requestPermission();
    }
  }

  // Show double-tap reply hint once per session on mobile
  if (window.innerWidth <= 768) {
    try {
      if (!sessionStorage.getItem("cr_reply_hint_shown")) {
        sessionStorage.setItem("cr_reply_hint_shown", "1");
        setTimeout(function () {
          showToast("Tip: Double-tap a message to reply", "info");
        }, 2500);
      }
    } catch (e) {}
  }

  // ---- Mobile keyboard fix ----
  // visualViewport.height = the visible area height (shrinks when keyboard opens).
  // chat-page-root has padding-top: var(--header-h) in CSS.
  // Setting its height = visualViewport.height keeps the send bar
  // exactly at the top of the keyboard.
  if (window.visualViewport) {
    function applyViewportHeight() {
      var root = document.querySelector(".chat-page-root");
      if (!root) return;

      if (window.innerWidth <= 768) {
        // For mobile, adjust for visualViewport changes (keyboard)
        root.style.height = window.visualViewport.height + "px";
        // Adjust for iOS panning
        root.style.top = window.visualViewport.offsetTop + "px";
        root.style.position = "absolute";

        var header = document.getElementById("cr-header");
        if (header) {
          header.style.position = "absolute";
          header.style.top = window.visualViewport.offsetTop + "px";
          header.style.width = "100%";
        }
      } else {
        root.style.height = "100vh";
        root.style.top = "0";
        root.style.position = "relative";

        var header = document.getElementById("cr-header");
        if (header) {
          header.style.position = "";
          header.style.top = "";
          header.style.width = "";
        }
      }

      var msgs = document.getElementById("chatMessages");
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
    window.visualViewport.addEventListener("resize", applyViewportHeight);
    window.visualViewport.addEventListener("scroll", applyViewportHeight);
    applyViewportHeight();

    // Also apply when inputs get focused
    document.querySelectorAll("input, textarea").forEach(function (el) {
      el.addEventListener("focus", function () {
        setTimeout(applyViewportHeight, 100);
      });
      el.addEventListener("blur", function () {
        setTimeout(applyViewportHeight, 100);
      });
    });
  }

  // All file uploads go through REST upload, then sent as FILE messages
  $("#fileInput").on("change", function (e) {
    var file = e.target.files[0];
    if (!file) return;
    $(this).val("");

    var formData = new FormData();
    formData.append("file", file);
    // Pass recipient info for access control
    if (selectedUser === "public") {
      formData.append("to", "public");
    } else if (activeGroupId != null) {
      formData.append("groupId", activeGroupId);
    } else if (selectedUser) {
      formData.append("to", selectedUser);
    }
    $.ajax({
      url: "/api/upload",
      method: "POST",
      data: formData,
      processData: false,
      contentType: false,
      success: function (data) {
        sendFileMessage(data.url, data.fileName, data.fileSize, data.mimeType);
      },
      error: function (xhr) {
        var msg = "Failed to upload file";
        if (xhr.responseJSON && xhr.responseJSON.error) msg += ": " + xhr.responseJSON.error;
        showToast(msg, "error");
      },
    });
  });

  // Hide context menu
  $(document).on("click", function (e) {
    if (!$(e.target).closest("#msg-context-menu").length) {
      $("#msg-context-menu").removeClass("show");
    }
  });

  // Menu Actions
  $("#menu-edit").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (contextMenuTargetId && contextMenuTargetRow) {
      var bubbleEl = contextMenuTargetRow.find(".msg-bubble");
      openEditInput(contextMenuTargetId, bubbleEl);
    }
  });

  $("#menu-delete").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (contextMenuTargetId) {
      openDeleteConfirmModal(contextMenuTargetId, false, 0);
    }
  });

  $("#menu-select").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (contextMenuTargetRow) {
      var body = $("#chat-body");
      if (!body.hasClass("selection-mode")) {
        body.addClass("selection-mode");
      }
      var cb = contextMenuTargetRow.find(".msg-checkbox");
      if (cb.length > 0) {
        cb.prop("checked", true);
        updateBulkSelection();
      }
    }
  });

  $("#menu-info").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (contextMenuTargetRow) {
      var delivered = contextMenuTargetRow.data("delivered-at") || "Not yet";
      var read = contextMenuTargetRow.data("read-at") || "Not yet";
      var isSender = contextMenuTargetRow.hasClass("from-me");
      var time = contextMenuTargetRow
        .find(".msg-meta")
        .text()
        .replace(/✓/g, "")
        .trim();

      $("#right-sidebar").addClass("open");
      rightPanelState.context = "private";
      $("#rpPanelTitle").text("Message Info");
      $("#rpTabs").show();
      $("#rpPrivateInfoCard").hide();
      $("#rightGroupPanel").hide();
      $("#rpFooter").hide();
      $("#rightProfileName").text("Message Info");
      $("#rightProfileUsername").text("Sent at: " + time);
      $("#rightProfileAvatar")
        .html('<i class="fi fi-rr-info"></i>')
        .css("background", "#3b82f6");
      setRightPanelTab("search");

      if (isSender) {
        $("#searchResultsContainer").html(
          '<div style="padding: 15px; color: #fff;">' +
            '<p style="margin-bottom: 10px;"><i class="fi fi-rr-check" style="color: rgba(255,255,255,0.5); margin-right: 8px;"></i> <strong>Delivered:</strong> ' +
            delivered +
            "</p>" +
            '<p><i class="fi fi-rr-check-double" style="color: #3b82f6; margin-right: 8px;"></i> <strong>Read:</strong> ' +
            read +
            "</p>" +
            "</div>",
        );
      } else {
        $("#searchResultsContainer").html(
          '<div style="padding: 15px; color: #fff; opacity: 0.8;">' +
            "<p>Received at " +
            time +
            ".</p>" +
            "</div>",
        );
      }
    }
  });

  // Image Modal Logic
  $(document).on("click", ".msg-image img", function () {
    var src = $(this).attr("src");
    $("#imageModalSrc").attr("src", src);
    $("#imageModal").addClass("show");
  });

  $(document).on("click", "#imageModalClose, #imageModal", function (e) {
    if (
      e.target.id === "imageModal" ||
      e.target.id === "imageModalClose" ||
      $(e.target).closest("#imageModalClose").length
    ) {
      $("#imageModal").removeClass("show");
    }
  });

  // ---- Reply Cancel ----
  $("#cancelReplyBtn").on("click", function () {
    clearReply();
  });

  // updateSendBtnMode is now defined globally above the document.ready block

  // ---- Send Button: acts as mic when input is empty ----
  updateSendBtnMode();
  $("#messageInput").on("input", updateSendBtnMode);

  $("#sendButton").on("click", function () {
    if ($("#sendButton").hasClass("recording-active")) {
      // Currently recording: click stops and sends
      stopVoiceRecording();
    } else if ($("#sendButton").hasClass("mic-mode")) {
      // Mic mode and not recording: start recording
      startVoiceRecording();
    } else {
      // Normal send mode
      sendMessage();
    }
  });

  // Cancel recording
  $("#voiceRecCancel").on("click", function () {
    cancelVoiceRecording();
  });

  // ---- Schedule Button ----
  $("#scheduleBtn").on("click", function () {
    var text = $("#messageInput").val().trim();
    if (!text) {
      showToast("Please type a message first", "info");
      return;
    }
    // Set min datetime to now
    var now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    var minStr = now.toISOString().slice(0, 16);
    $("#scheduleDateInput").attr("min", minStr).val("");
    $("#schedulePreviewText").text(
      text.length > 60 ? text.substring(0, 60) + "…" : text,
    );
    $("#scheduleModal").show();
  });

  $("#cancelScheduleBtn, #closeScheduleModal").on("click", function () {
    $("#scheduleModal").hide();
  });

  $("#confirmScheduleBtn").on("click", function () {
    var text = $("#messageInput").val().trim();
    var dateVal = $("#scheduleDateInput").val();
    if (!text || !dateVal) {
      showToast("Please fill in all fields", "info");
      return;
    }
    if (!selectedUser || selectedUser === "public" || activeGroupId != null) {
      showToast("Scheduling is only for private chats", "info");
      return;
    }
    var scheduledAt = new Date(dateVal);
    if (scheduledAt <= new Date()) {
      showToast("Please choose a future time", "info");
      return;
    }
    // ISO format for backend
    var isoStr = scheduledAt.toISOString().slice(0, 19);
    var payload = {
      senderName: currentUsername,
      receiverName: selectedUser,
      message: text,
      messageType: "TEXT",
      status: "MESSAGE",
      Date: isoStr,
    };
    if (replyToId) {
      payload.replyToId = replyToId;
      payload.replyToContent = replyToContent;
      payload.replyToSender = replyToSender;
    }
    stompClient.send("/app/schedule-message", {}, JSON.stringify(payload));
    $("#scheduleModal").hide();
    $("#messageInput").val("");
    clearReply();
  });

  $("#btnOpenCreateGroup").on("click", function (e) {
    e.preventDefault();
    openCreateGroupModal();
  });
  $("#cancelCreateGroupBtn, #closeCreateGroupModal").on("click", function () {
    $("#createGroupModal").hide();
    resetCreateGroupPhotoUI();
  });

  $("#confirmCreateGroupBtn").on("click", submitCreateGroup);

  $("#createGroupPickPhotoBtn").on("click", function () {
    $("#createGroupPicture").trigger("click");
  });
  $("#createGroupRemovePhotoBtn").on("click", resetCreateGroupPhotoUI);
  $(document).on("change", "#createGroupPicture", onCreateGroupFileChosen);
  $(document).on(
    "input",
    "#createGroupMemberSearch",
    filterCreateGroupMemberList,
  );
  $(document).on(
    "change",
    "#createGroupMemberPicks .create-group-contact-cb",
    function () {
      var card = $(this).closest(".create-group-member-card");
      card.toggleClass("create-group-member-card--on", this.checked);
      updateCreateGroupSelectedCount();
    },
  );

  $("#rightGroupAddMemberBtn").on("click", rightSidebarAddMember);
  $("#rightGroupLeaveBtn").on("click", rightSidebarLeaveGroup);
  $("#rightGroupSaveProfileBtn").on("click", rightSidebarSaveGroupProfile);
});

function isMobileViewport() {
  return window.innerWidth <= 768;
}

function closeMobilePanels() {
  if (!isMobileViewport()) return;
  $("#chat-sidebar").removeClass("mobile-open");
  $("#right-sidebar").removeClass("open");
  closeThreadPanel();
}

function shouldIgnoreMessageGesture(target) {
  return (
    $(target).closest(
      "button, input, textarea, select, a, audio, .msg-checkbox, .msg-reply-quote, .image-modal, .msg-image img",
    ).length > 0
  );
}

function getMessageActionText(row) {
  var bubble = row.find(".msg-bubble").first();
  if (bubble.hasClass("msg-image")) return "[Image]";
  if (bubble.hasClass("msg-audio")) return "[Voice Message]";

  var clone = bubble.clone();
  clone
    .find(".msg-edited-label, .msg-invite-btn, .edit-input-container")
    .remove();
  return clone.text().replace(/\s+/g, " ").trim();
}

function startReplyFromRow(row, messageId) {
  if (!row || !messageId || $("#chat-body").hasClass("selection-mode")) return;

  replyToId = messageId;
  var isSender = row.hasClass("from-me");
  replyToSender = isSender ? currentUsername : row.data("sender");
  replyToContent = getMessageActionText(row);

  $("#replyPreviewSender").text("Replying to " + replyToSender);
  $("#replyPreviewContent").text(replyToContent);
  $("#replyPreviewBar").show();
  $("#messageInput").focus();
}

// Handle right click, long press, and mobile double tap
function bindContextMenu(row, messageId, isSender) {
  var timer;
  var touchMoved = false;
  var longPressFired = false;
  var touchStartX = 0;
  var touchStartY = 0;

  row.on("contextmenu", function (e) {
    e.preventDefault();
    showContextMenu(e.pageX, e.pageY, row, messageId, isSender);
  });

  row.on("dblclick", function (e) {
    if (shouldIgnoreMessageGesture(e.target)) return;
    e.preventDefault();
    startReplyFromRow(row, messageId);
  });

  row
    .on("touchstart", function (e) {
      if (shouldIgnoreMessageGesture(e.target)) return;
      touchMoved = false;
      longPressFired = false;
      var startTouch = e.originalEvent.touches[0];
      touchStartX = startTouch.pageX;
      touchStartY = startTouch.pageY;
      timer = setTimeout(function () {
        longPressFired = true;
        var touch = e.originalEvent.touches[0];
        showContextMenu(touch.pageX, touch.pageY, row, messageId, isSender);
      }, 500); // 500ms long press
    })
    .on("touchmove", function (e) {
      var moveTouch = e.originalEvent.touches[0];
      if (
        Math.abs(moveTouch.pageX - touchStartX) > 10 ||
        Math.abs(moveTouch.pageY - touchStartY) > 10
      ) {
        touchMoved = true;
        clearTimeout(timer);
      }
    })
    .on("touchend", function (e) {
      clearTimeout(timer);
      if (
        shouldIgnoreMessageGesture(e.target) ||
        touchMoved ||
        longPressFired ||
        $("#chat-body").hasClass("selection-mode")
      )
        return;

      var now = Date.now();
      var lastTapAt = row.data("last-tap-at") || 0;
      if (now - lastTapAt < 320) {
        row.data("last-tap-at", 0);
        startReplyFromRow(row, messageId);
        e.preventDefault();
      } else {
        row.data("last-tap-at", now);
      }
    })
    .on("touchcancel", function () {
      clearTimeout(timer);
    });
}

function showContextMenu(x, y, row, messageId, isSender) {
  if ($("#chat-body").hasClass("selection-mode")) return;
  contextMenuTargetId = messageId;
  contextMenuTargetRow = row;

  if (isSender && messageId) {
    $("#menu-edit").show();
    $("#menu-delete").show();
    $("#menu-info").show();
    $("#menu-delete-for-me").hide();
  } else {
    $("#menu-edit").hide();
    $("#menu-delete").hide();
    $("#menu-info").hide();
    // "Delete for me" only in private chats (not public, not group)
    var isPrivate = selectedUser !== "public" && activeGroupId == null;
    if (isPrivate && messageId) {
      $("#menu-delete-for-me").show();
    } else {
      $("#menu-delete-for-me").hide();
    }
  }

  // Pin / Forward: show for everyone
  if (messageId) {
    $("#menu-pin").show();
    $("#menu-forward").show();
  } else {
    $("#menu-pin").hide();
    $("#menu-forward").hide();
  }

  // Update pin label based on current pin state
  if (currentPinnedMsg && currentPinnedMsg.id == messageId) {
    $("#menu-pin").html('<i class="fi fi-rr-thumbtack"></i> Unpin');
  } else {
    $("#menu-pin").html('<i class="fi fi-rr-thumbtack"></i> Pin');
  }

  var menu = $("#msg-context-menu");
  menu.css({ top: y + "px", left: x + "px" });
  menu.addClass("show");

  var menuEl = menu[0];
  var rect = menuEl.getBoundingClientRect();
  var safeLeft = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  var safeTop = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.css({ top: safeTop + "px", left: safeLeft + "px" });
}

// Context menu items are now in HTML — no prepend needed
$(document).ready(function () {
  $("#menu-copy").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (!contextMenuTargetRow) return;
    var text = getMessageActionText(contextMenuTargetRow);
    if (!text) {
      showToast("Nothing to copy", "info");
      return;
    }
    copyToClipboard(text);
    showToast("Message copied", "success");
  });

  $("#menu-thread-ctx").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (contextMenuTargetId) {
      openThreadPanel(contextMenuTargetId);
    }
  });

  $("#menu-reply-ctx").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (contextMenuTargetRow && contextMenuTargetId) {
      startReplyFromRow(contextMenuTargetRow, contextMenuTargetId);
    }
  });

  // ---- PIN ----
  $("#menu-pin").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (!contextMenuTargetId) return;
    pinMessage(contextMenuTargetId);
  });

  // ---- FORWARD ----
  $("#menu-forward").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (!contextMenuTargetId || !contextMenuTargetRow) return;
    var text = getMessageActionText(contextMenuTargetRow);
    openForwardModal(contextMenuTargetId, text);
  });

  // ---- DELETE FOR ME (local only, no server call) ----
  $("#menu-delete-for-me").on("click", function () {
    $("#msg-context-menu").removeClass("show");
    if (!contextMenuTargetId) return;
    openDeleteForMeModal(contextMenuTargetId);
  });

  // ---- Delete Confirm Modal events ----
  $("#delete-confirm-close, #delete-confirm-cancel").on("click", function () {
    closeDeleteConfirmModal();
  });

  $("#delete-confirm-ok").on("click", function () {
    var msgId = $("#delete-confirm-modal").data("message-id");
    var isBulk = $("#delete-confirm-modal").data("is-bulk") === "1";
    closeDeleteConfirmModal();
    if (isBulk) {
      var checkedIds = [];
      $(".msg-checkbox:checked").each(function () {
        checkedIds.push($(this).val());
      });
      stompClient.send(
        "/app/bulk-delete-messages",
        {},
        JSON.stringify({
          senderName: currentUsername,
          ids: checkedIds,
          messageType: "TEXT",
        }),
      );
      $("#chat-body").removeClass("selection-mode");
      $(".msg-checkbox").prop("checked", false);
    } else {
      stompClient.send(
        "/app/delete-message",
        {},
        JSON.stringify({
          id: msgId,
          senderName: currentUsername,
          messageType: "TEXT",
        }),
      );
    }
  });

  $("#delete-confirm-modal").on("keydown", function (e) {
    if (e.key === "Escape") closeDeleteConfirmModal();
    trapFocusInModal(e, this);
  });

  // ---- Delete For Me Modal events ----
  $("#delete-for-me-close, #delete-for-me-cancel").on("click", function () {
    closeDeleteForMeModal();
  });

  $("#delete-for-me-ok").on("click", function () {
    var msgId = $("#delete-for-me-modal").data("message-id");
    closeDeleteForMeModal();
    fetch("/api/messages/" + msgId + "/delete-for-me", { method: "POST" })
      .then(function (res) {
        if (res.ok) {
          $("#msg-" + msgId).fadeOut(200, function () {
            $(this).remove();
          });
        } else {
          showToast("Could not hide message. Please try again.", "error");
        }
      })
      .catch(function () {
        showToast("Could not hide message. Please try again.", "error");
      });
  });

  $("#delete-for-me-modal").on("keydown", function (e) {
    if (e.key === "Escape") closeDeleteForMeModal();
    trapFocusInModal(e, this);
  });
});

/* ==============================================
   WEBSOCKET
   ============================================== */
function connect() {
  var socket = new SockJS("/ws");
  stompClient = Stomp.over(socket);
  stompClient.debug = null; // silence debug logs
  stompClient.connect({}, function (frame) {
    // Clean up any stale call sessions from a previous crash / force-close.
    // This runs silently so it never blocks the chat page from loading.
    $.post("/api/calls/cleanup").fail(function () {});

    // Public channel
    stompClient.subscribe("/chatroom/public", function (out) {
      var msg = JSON.parse(out.body);
      if (msg.senderName === "System") {
        showToast(msg.message || msg.content, "error");
        return;
      }
      if (msg.status === "DELETE") {
        $("#msg-" + msg.id).remove();
        return;
      } else if (msg.status === "BULK_DELETE") {
        if (msg.ids) {
          msg.ids.forEach(function (id) {
            $("#msg-" + id).remove();
          });
        }
        return;
      }
      // Update presence instantly on JOIN/LEAVE
      if (msg.status === "JOIN") {
        updateContactPresence(msg.senderName, true, "Online");
        return;
      } else if (msg.status === "LEAVE") {
        var now = new Date();
        var time = now.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        updateContactPresence(msg.senderName, false, "Last seen at " + time);
        return;
      }

      if (
        selectedUser === "public" &&
        msg.status !== "JOIN" &&
        msg.status !== "LEAVE"
      ) {
        if (msg.status === "REACTION") {
          handleReactionUpdate(msg.id, msg.reactions);
        } else if (msg.status === "MESSAGE" || msg.status === "EDIT") {
          // Check if it's an edit
          if ($("#msg-" + msg.id).length > 0) {
            updateMessageBubble(msg.id, msg.content || msg.message);
          } else {
            var content = msg.content || msg.message;
            var type = msg.messageType || "TEXT";
            showMessage(
              msg.senderName,
              content,
              msg.senderName === currentUsername,
              true,
              type,
              msg.id,
              msg.edited,
              false,
              false,
              null,
              null,
              msg.replyToId,
              msg.replyToContent,
              msg.replyToSender,
              false,
              null,
              msg.forwardedFrom,
              msg.pinned,
              msg.fileName,
              msg.fileSize,
              msg.mimeType,
            );
            checkThreadMessage(msg);
          }
        }
      }
    });
    // Private channel
    stompClient.subscribe(
      "/user/" + currentUsername + "/private",
      function (out) {
        var msg = JSON.parse(out.body);

        // Handle typing indicator
        if (msg.status === "TYPING") {
          if (msg.senderName && msg.senderName !== currentUsername) {
            handleTypingIndicator(msg.senderName, msg.typing, msg.messageType);
          }
          return;
        }

        // Handle system errors (banned)
        if (msg.senderName === "System") {
          showToast(msg.message || msg.content, "error");
          return;
        }

        if (msg.status === "DELETE") {
          $("#msg-" + msg.id).remove();
          return;
        } else if (msg.status === "BULK_DELETE") {
          if (msg.ids) {
            msg.ids.forEach(function (id) {
              $("#msg-" + id).remove();
            });
          }
          return;
        } else if (msg.status === "DELIVERED") {
          var row = $("#msg-" + msg.id);
          var receipts = row.find(".msg-receipts");
          if (receipts.length > 0) {
            receipts.html("✓✓").addClass("delivered").removeClass("read");
            row.data("delivered-at", msg.deliveredAt);
          }
          return;
        } else if (msg.status === "READ") {
          var row = $("#msg-" + msg.id);
          var receipts = row.find(".msg-receipts");
          if (receipts.length > 0) {
            receipts.html("✓✓").addClass("read").removeClass("delivered");
            row.data("read-at", msg.readAt);
          }
          return;
        } else if (msg.status === "EDIT") {
          if ($("#msg-" + msg.id).length > 0) {
            updateMessageBubble(msg.id, msg.content || msg.message);
          }
          return;
        } else if (msg.status === "REACTION") {
          handleReactionUpdate(msg.id, msg.reactions);
          return;
        }

        if (msg.groupId != null && msg.groupId !== undefined) {
          routeGroupIncomingStomp(msg);
          return;
        }

        // If we don't have this contact in our list, refresh contacts
        if (
          $("#contact-item-" + msg.senderName).length === 0 &&
          msg.senderName !== currentUsername
        ) {
          fetchContacts();
        }

        var isOwnMessage = msg.senderName === currentUsername;

        if (isOwnMessage) {
          // This is our own message echoed back from server with the DB ID
          // Show it in our panel if we're in the correct chat
          if (selectedUser === msg.receiverName) {
            if ($("#msg-" + msg.id).length === 0) {
              var content = msg.content || msg.message;
              var type = msg.messageType || "TEXT";
              showMessage(
                msg.senderName,
                content,
                true,
                false,
                type,
                msg.id,
                msg.edited,
                msg.delivered,
                msg.read,
                msg.deliveredAt,
                msg.readAt,
                msg.replyToId,
                msg.replyToContent,
                msg.replyToSender,
                false,
                null,
                msg.forwardedFrom,
                msg.pinned,
                msg.fileName,
                msg.fileSize,
                msg.mimeType,
              );
              checkThreadMessage(msg);
            }
          }
        } else if (selectedUser === msg.senderName) {
          // Received message from the person we're currently chatting with
          if ($("#msg-" + msg.id).length > 0) {
            updateMessageBubble(msg.id, msg.content || msg.message);
          } else {
            var content = msg.content || msg.message;
            var type = msg.messageType || "TEXT";
            showMessage(
              msg.senderName,
              content,
              false,
              false,
              type,
              msg.id,
              msg.edited,
              false,
              false,
              null,
              null,
              msg.replyToId,
              msg.replyToContent,
              msg.replyToSender,
              false,
              null,
              msg.forwardedFrom,
              msg.pinned,
              msg.fileName,
              msg.fileSize,
              msg.mimeType,
            );
            checkThreadMessage(msg);

            // Send Read ACK since we're actively viewing this chat
            if (document.hasFocus()) {
              stompClient.send(
                "/app/message-read",
                {},
                JSON.stringify({ id: msg.id, senderName: currentUsername }),
              );
            } else {
              stompClient.send(
                "/app/message-delivered",
                {},
                JSON.stringify({ id: msg.id, senderName: currentUsername }),
              );
            }
          }
        } else {
          // Received message while looking at a different chat - send delivery ACK
          stompClient.send(
            "/app/message-delivered",
            {},
            JSON.stringify({ id: msg.id, senderName: currentUsername }),
          );

          // Increment unread count
          incrementUnreadCount("private", msg.senderName);

          var isLocked =
            contactsCache &&
            contactsCache.some(function (c) {
              return c.username === msg.senderName && c.locked === "true";
            });

          if (isLocked) {
            showToast("New message from " + msg.senderName, "info");
            updateLastMsg(msg.senderName, "🔒 Locked Message");
          } else {
            showToast("New message from " + msg.senderName, "info");
            updateLastMsg(
              msg.senderName,
              msg.messageType === "IMAGE"
                ? "📷 Image"
                : msg.content || msg.message,
            );

            // Show browser notification
            if (
              "Notification" in window &&
              Notification.permission === "granted"
            ) {
              var n = new Notification("New message from " + msg.senderName, {
                body:
                  msg.messageType === "IMAGE"
                    ? "📷 Sent an image"
                    : msg.content || msg.message,
                icon: "/images/favicon.ico",
              });
              try {
                var audio = new Audio(
                  "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3",
                );
                audio.volume = 0.5;
                audio.play();
              } catch (e) {}
            }
          }
        }
      },
    );
  });
}

/* ==============================================
   CONTACTS
   ============================================== */
function fetchContacts() {
  $.get("/api/contacts", function (data) {
    contactsCache = data || [];

    // Keep the public chat entry (first child), append the rest
    var existing = $("#onlineUsersList .cr-contact-item.public-chat-item");
    $("#onlineUsersList").empty().append(existing);

    // Initialize unread counts from server data
    data.forEach(function (contact) {
      var serverUnread = parseInt(contact.unread, 10) || 0;
      unreadCounts.private[contact.username] = serverUnread;
      var avatarHtml = contact.profilePicture
        ? '<div class="cr-contact-avatar" style="background:none;padding:0;border:1.5px solid rgba(255,255,255,0.1);"><img src="' +
          contact.profilePicture +
          '" alt=""/></div>'
        : '<div class="cr-contact-avatar" style="background:' +
          getAvatarColor(contact.username) +
          ';">' +
          getInitial(contact.fullname || contact.username) +
          "</div>";

      var displayName = contact.fullname || contact.username;
      var unreadCount = unreadCounts.private[contact.username] || 0;
      var badgeHtml =
        unreadCount > 0
          ? '<div class="cr-unread-badge" id="unread-badge-' +
            contact.username +
            '">' +
            (unreadCount > 99 ? "99+" : unreadCount) +
            "</div>"
          : "";
      var presenceText =
        contact.online === "true" ? "Online" : contact.presence || "Offline";
      if (contact.locked === "true") {
        presenceText = "🔒 Locked Chat";
      }
      var onlineDot =
        contact.online === "true"
          ? '<span class="cr-contact-online-dot"></span>'
          : '<span class="cr-contact-online-dot cr-contact-offline-dot"></span>';

      var item = $(
        '<div class="cr-contact-item" id="contact-item-' +
          contact.username +
          '" ' +
          'data-username="' +
          contact.username +
          '" ' +
          'data-fullname="" ' +
          'data-avatar="' +
          (contact.profilePicture || "") +
          '">' +
          avatarHtml +
          badgeHtml +
          '<div class="cr-contact-info">' +
          '<div class="cr-contact-name"></div>' +
          '<div class="contact_last_msg" id="last-msg-' +
          contact.username +
          '">' +
          presenceText +
          "</div>" +
          "</div>" +
          "</div>",
      );
      var nameEl = item.find(".cr-contact-name");
      nameEl.text(displayName);
      if (onlineDot) nameEl.append(onlineDot);
      item.attr("data-fullname", displayName);
      item.on("click", function () {
        selectUser(contact.username);
      });
      $("#onlineUsersList").append(item);
    });

    // Re-attach tooltip after contacts loaded
    initTooltip();
    fetchGroups();
  }).fail(function () {
    fetchGroups();
  });
}

function fetchGroups() {
  $.get("/api/groups", function (groups) {
    $("#groupChatList").empty();
    (groups || []).forEach(function (g) {
      var avatarHtml = g.picture
        ? '<div class="cr-contact-avatar cr-group-avatar group-avatar-img"><img src="' +
          g.picture +
          '" alt=""/></div>'
        : '<div class="cr-contact-avatar cr-group-avatar" style="background:' +
          getAvatarColor(g.name) +
          ';">' +
          getInitial(g.name) +
          "</div>";

      var unreadCount = unreadCounts.groups[g.id] || 0;
      var badgeHtml =
        unreadCount > 0
          ? '<div class="cr-unread-badge" id="unread-badge-group-' +
            g.id +
            '">' +
            (unreadCount > 99 ? "99+" : unreadCount) +
            "</div>"
          : "";
      var subText = g.myRole === "ADMIN" ? "Admin" : "Member";
      if (g.locked) {
        subText = "🔒 Locked";
      }

      var item = $(
        '<div class="cr-contact-item cr-contact-item--group" id="contact-group-' +
          g.id +
          '" data-group-id="' +
          g.id +
          '">' +
          avatarHtml +
          badgeHtml +
          '<div class="cr-contact-info">' +
          '<div class="cr-contact-name"></div>' +
          '<div class="contact_last_msg" id="last-msg-group-' +
          g.id +
          '">' +
          subText +
          "</div>" +
          "</div>" +
          "</div>",
      );
      item.find(".cr-contact-name").text(g.name || "Group");
      item.on("click", function () {
        selectGroupChat(g.id);
      });
      $("#groupChatList").append(item);
    });
  });
}

function routeGroupIncomingStomp(msg) {
  if (msg.status === "DELETE") {
    $("#msg-" + msg.id).remove();
    return;
  }
  if (msg.status === "BULK_DELETE") {
    if (msg.ids) {
      msg.ids.forEach(function (id) {
        $("#msg-" + id).remove();
      });
    }
    return;
  }
  if (msg.status === "EDIT") {
    if ($("#msg-" + msg.id).length > 0) {
      updateMessageBubble(msg.id, msg.content || msg.message);
    }
    return;
  }
  if (msg.status === "REACTION") {
    handleReactionUpdate(msg.id, msg.reactions);
    return;
  }
  if (msg.status === "READ") {
    // Update group read receipt display on the message
    var row = $("#msg-" + msg.id);
    if (row.length > 0) {
      var receipts = row.find(".msg-group-read-receipts");
      if (receipts.length > 0) {
        // Fetch updated read-by list from server
        $.get("/api/messages/" + msg.id + "/read-by", function (data) {
          if (data && data.length > 0) {
            var names = data.map(function (r) { return r.username; });
            receipts.html('<i class="fi fi-rr-check-double"></i> ' + names.length);
            receipts.attr("title", "Read by " + names.join(", "));
          }
        });
      }
    }
    return;
  }
  if (msg.status !== "MESSAGE") return;

  var isSystem = msg.messageType && msg.messageType.indexOf("SYSTEM_") === 0;
  var previewText =
    msg.messageType === "IMAGE"
      ? "📷 Image"
      : msg.messageType === "AUDIO"
        ? "🎤 Voice"
        : msg.message || msg.content || "";

  if (activeGroupId === msg.groupId) {
    if ($("#msg-" + msg.id).length === 0) {
      var c = msg.message || msg.content;
      var t = msg.messageType || "TEXT";
      var isOwn = msg.senderName === currentUsername;
      showMessage(
        msg.senderName,
        c,
        isOwn,
        false,
        t,
        msg.id,
        !!msg.edited,
        false,
        false,
        null,
        null,
        msg.replyToId,
        msg.replyToContent,
        msg.replyToSender,
        true,
        null,
        msg.forwardedFrom,
        msg.pinned,
        msg.fileName,
        msg.fileSize,
        msg.mimeType,
      );
      checkThreadMessage(msg);

      // Send read ACK
      if (!isOwn && msg.senderName !== "System") {
        stompClient.send("/app/message-read", {}, JSON.stringify({ id: msg.id, senderName: currentUsername }));
      }
    }
  } else if (!isSystem) {
    // Increment unread count for the group
    incrementUnreadCount("group", msg.groupId);

    var isLocked =
      groupsCache &&
      groupsCache.some(function (g) {
        return g.id === msg.groupId && g.locked;
      });

    showToast("New message in a group chat", "info");
    if (isLocked) {
      updateLastMsgForGroup(msg.groupId, "🔒 Locked Message");
    } else {
      updateLastMsgForGroup(msg.groupId, previewText);
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("Group chat", {
            body: previewText.substring(0, 120),
            icon: "/images/favicon.gg",
          });
        }
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function updateLastMsgForGroup(groupId, text) {
  var el = $("#last-msg-group-" + groupId);
  if (!el.length) return;
  var preview = text.length > 24 ? text.substring(0, 24) + "…" : text;
  el.text(preview);
}

function selectGroupChat(id) {
  closeThreadPanel();
  $("#rpPanelTitle").text("Group Info");
  activeGroupId = id;
  selectedUser = "__none__";
  $(".cr-contact-item").removeClass("active");
  // Clear typing indicator when switching chats
  clearTimeout(typingTimeout);
  typingSender = null;
  $("#contact-group-" + id).addClass("active");

  $.get("/api/groups/" + id, function (g) {
    $("#selectedUserName").text(g.name || "Group");
    $("#selectedUserInfo").text("Group · tap for members & settings");
    if (g.picture) {
      $("#chatAvatarCircle")
        .css("background", "none")
        .html(
          '<img src="' +
            g.picture +
            '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>',
        );
    } else {
      $("#chatAvatarCircle")
        .html(getInitial(g.name || "G"))
        .css("background", getAvatarColor(g.name || "group"));
    }
  }).fail(function () {
    $("#selectedUserName").text("Group");
    $("#selectedUserInfo").text("Group chat");
    updateHeaderAvatarEl(getAvatarColor("group"), "G");
  });

  loadGroupHistory(id);
  hideTooltip();
  clearReply();
  clearUnreadCount("group", id);
  $("#scheduleBtn").hide();

  if (window.innerWidth <= 768) {
    $("#chat-sidebar").removeClass("mobile-open");
  }

  // Refresh pinned bar for this group
  setTimeout(loadPinnedBarForCurrentChat, 80);
  // Cancel any active recording when switching chats
  if (isRecording) cancelVoiceRecording();
  updateSendBtnMode();
}

function resetCreateGroupPhotoUI() {
  $("#createGroupPicture").val("");
  $("#createGroupPhotoPreviewImg").removeClass("is-visible").attr("src", "");
  $("#createGroupPhotoPh").removeClass("is-hidden");
  $("#createGroupRemovePhotoBtn").hide();
}

function onCreateGroupFileChosen(e) {
  var f = e.target.files && e.target.files[0];
  if (!f) {
    resetCreateGroupPhotoUI();
    return;
  }
  if (!f.type || f.type.indexOf("image") !== 0) {
    showToast("Please choose an image file", "info");
    e.target.value = "";
    resetCreateGroupPhotoUI();
    return;
  }
  if (f.size > 5 * 1024 * 1024) {
    showToast("Photo must be under 5MB", "error");
    e.target.value = "";
    resetCreateGroupPhotoUI();
    return;
  }
  var fr = new FileReader();
  fr.onload = function () {
    $("#createGroupPhotoPreviewImg")
      .attr("src", fr.result)
      .addClass("is-visible");
    $("#createGroupPhotoPh").addClass("is-hidden");
    $("#createGroupRemovePhotoBtn").show();
  };
  fr.readAsDataURL(f);
}

function filterCreateGroupMemberList() {
  var raw = ($("#createGroupMemberSearch").val() || "").toLowerCase().trim();
  var q = raw.startsWith("@") ? raw.slice(1) : raw;
  $("#createGroupMemberPicks .create-group-member-card").each(function () {
    var hay = $(this).attr("data-filter") || "";
    var match = q === "" || hay.indexOf(q) !== -1;
    $(this).toggleClass("create-group-member-card--filtered-out", !match);
  });
}

function updateCreateGroupSelectedCount() {
  var pill = $("#createGroupSelectedCount");
  if (!pill.length) return;
  if (!$(".create-group-search-wrap").is(":visible")) {
    pill.text("No contacts selected");
    return;
  }
  var n = $("#createGroupMemberPicks .create-group-contact-cb:checked").length;
  if (n === 0) pill.text("No contacts selected");
  else pill.text(n + (n === 1 ? " contact" : " contacts") + " selected");
}

function openCreateGroupModal() {
  $("#createGroupName").val("");
  $("#createGroupMemberSearch").val("");
  resetCreateGroupPhotoUI();

  var box = $("#createGroupMemberPicks");
  box.empty();

  if (!contactsCache || contactsCache.length === 0) {
    $(".create-group-search-wrap").hide();
    $(".create-group-member-list-scroll").hide();
    $("#createGroupMembersEmptyHint").show();
    updateCreateGroupSelectedCount();
    $("#createGroupModal").show();
    return;
  }

  $("#createGroupMembersEmptyHint").hide();
  $(".create-group-search-wrap").show();
  $(".create-group-member-list-scroll").show();

  (contactsCache || []).forEach(function (c) {
    var lid = "gmem-" + String(c.username).replace(/[^a-zA-Z0-9_-]/g, "_");
    var display = (c.fullname || "").trim();
    var filterHay = (
      (display ? display + " " : "") +
      c.username +
      " @" +
      c.username
    ).toLowerCase();

    var card = $('<label class="create-group-member-card"/>')
      .attr({ role: "listitem" })
      .attr("data-filter", filterHay);

    var cb = $('<input type="checkbox" class="create-group-contact-cb"/>').attr(
      { id: lid },
    );
    cb.data("username", c.username);

    var av = $('<div class="create-group-member-avatar"/>');
    if (c.profilePicture) {
      av.append($('<img alt=""/>').attr("src", c.profilePicture));
    } else {
      av.css("background", getAvatarColor(c.username)).text(
        getInitial(display || c.username),
      );
    }

    var meta = $('<div class="create-group-member-meta"/>');
    meta.append(
      $('<div class="create-group-member-name"/>').text(display || c.username),
    );
    meta.append(
      $('<div class="create-group-member-user"/>').text("@" + c.username),
    );

    var tick = $('<div class="create-group-member-tick"/>').append(
      '<i class="fi fi-br-check"></i>',
    );

    card.append(cb).append(av).append(meta).append(tick);
    box.append(card);
  });

  updateCreateGroupSelectedCount();
  $("#createGroupModal").show();
}

function submitCreateGroup() {
  var name = $("#createGroupName").val().trim();
  if (!name) {
    showToast("Enter a group name", "info");
    return;
  }

  var members = [];
  $("#createGroupMemberPicks .create-group-contact-cb:checked").each(
    function () {
      members.push($(this).data("username"));
    },
  );

  function postBody(picture) {
    $.ajax({
      url: "/api/groups",
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({
        name: name,
        memberUsernames: members,
        picture: picture || undefined,
      }),
      success: function (resp) {
        $("#createGroupModal").hide();
        resetCreateGroupPhotoUI();
        fetchGroups();
        if (resp && resp.id) selectGroupChat(resp.id);
        showToast("Group created", "success");
      },
      error: function (xhr) {
        showToast(
          (xhr.responseText && xhr.responseText.substring(0, 200)) ||
            "Could not create group",
          "error",
        );
      },
    });
  }

  var file =
    $("#createGroupPicture")[0].files && $("#createGroupPicture")[0].files[0];
  if (file) {
    if (file.size > 5 * 1024 * 1024) {
      showToast("Photo must be under 5MB", "error");
      return;
    }
    var fr = new FileReader();
    fr.onload = function () {
      postBody(fr.result);
    };
    fr.readAsDataURL(file);
  } else {
    postBody(null);
  }
}

function loadGroupHistory(groupId) {
  $("#chatMessages").empty();
  $("#chatLockOverlay").hide();

  $.ajax({
    url: "/api/messages/group/" + groupId,
    method: "GET",
    success: function (messages) {
      $("#chat-lock-btn")
        .show()
        .off("click")
        .on("click", function () {
          promptSetChatLock(null, groupId);
        });
      messages.forEach(function (msg) {
        showMessage(
          msg.senderName,
          msg.content,
          msg.senderName === currentUsername,
          false,
          msg.messageType || "TEXT",
          msg.id,
          msg.edited || false,
          false,
          false,
          null,
          null,
          msg.replyToId,
          msg.replyToContent,
          msg.replyToSender,
          true,
          msg.reactions,
          msg.forwardedFrom,
          msg.pinned,
          msg.fileName,
          msg.fileSize,
          msg.mimeType,
          msg.readBy,
        );

        // Send read ACK for group messages from others
        if (msg.senderName !== currentUsername && msg.senderName !== "System") {
          stompClient.send("/app/message-read", {}, JSON.stringify({ id: msg.id, senderName: currentUsername }));
        }
      });
      updateChatLockStatus(null, groupId);
    },
    error: function (xhr) {
      if (xhr.status === 403 && xhr.responseJSON && xhr.responseJSON.locked) {
        $("#chatLockOverlay").css("display", "flex");
        $("#chatLockPasswordInput").val("").focus();
        $("#removeChatLockBtn").show();
        $("#chat-lock-btn").hide();
      }
    },
  });
}

function selectUser(user) {
  closeThreadPanel();
  activeGroupId = null;
  selectedUser = user;
  $("#rpPanelTitle").text("Contact Info");
  clearTimeout(typingTimeout);
  typingSender = null;
  $(".cr-contact-item").removeClass("active");
  $("#contact-item-" + user).addClass("active");

  if (user === "public") {
    $("#selectedUserName").text("Public Chat Room");
    $("#selectedUserInfo").text("Chatting with everyone");
    updateHeaderAvatarEl(
      "linear-gradient(135deg,#2563eb,#7c3aed)",
      '<i class="fi fi-sr-comment-dots"></i>',
    );
    loadChatHistory(user);
  } else {
    $.get("/api/users/" + user, function (info) {
      var privacy = info.contactPrivacy || "everyone";
      if (!info.isContact && !info.blocked) {
        if (privacy === "invitation") {
          showInvitationRequired(user, info);
          return;
        }
      }
      $("#selectedUserName").text(info.fullname || user);
      $("#selectedUserInfo").text("@" + user + " · Private chat");
      updateHeaderAvatarEl(
        getAvatarColor(user),
        getInitial(info.fullname || user),
      );

      $.ajax({
        url: "/api/contacts/" + encodeURIComponent(user),
        method: "POST",
        success: function (res) {
          if (res && res.added === true) fetchContacts();
        },
      });
      proceedChat(user);
    }).fail(function () {
      $("#selectedUserName").text(user);
      $("#selectedUserInfo").text("Private chat");
      updateHeaderAvatarEl(getAvatarColor(user), getInitial(user));
      proceedChat(user);
    });
  }

  hideTooltip();
  clearReply();
  if (user !== "public") clearUnreadCount("private", user);
  if (user === "public") { $("#scheduleBtn").hide(); } else { $("#scheduleBtn").show(); }
  if (window.innerWidth <= 768) $("#chat-sidebar").removeClass("mobile-open");
  setTimeout(loadPinnedBarForCurrentChat, 80);
  if (isRecording) cancelVoiceRecording();
  updateSendBtnMode();
}

function proceedChat(user) {
  loadChatHistory(user);
}

function showInvitationRequired(user, info) {
  $("#selectedUserName").text(info.fullname || user);
  $("#selectedUserInfo").text("@" + user + " · Invitation required");
  updateHeaderAvatarEl(getAvatarColor(user), getInitial(info.fullname || user));
  $("#chatMessages").html(
    '<div class="invitation-required"><div class="invitation-icon"><i class="fi fi-sr-shield"></i></div><div class="invitation-title">Contact Required</div><div class="invitation-text">"' + (info.fullname || user) + '" requires an invitation to chat. Ask them for an invite link to get started.</div></div>'
  );
}

function updateHeaderAvatar(name) {
  var circle = document.getElementById("chatAvatarCircle");
  if (circle) {
    circle.style.background = getAvatarColor(name);
    circle.textContent = getInitial(name);
  }
}
function updateHeaderAvatarEl(bg, content) {
  var el = document.getElementById("chatAvatarCircle");
  if (!el) return;
  el.style.background = bg;
  el.innerHTML = content;
}

/* ==============================================
   MESSAGES
   ============================================== */
function loadChatHistory(user) {
  $("#chatMessages").empty();
  $("#chatLockOverlay").hide();

  $.ajax({
    url: "/api/messages/" + user,
    method: "GET",
    success: function (messages) {
      if (user === "public") {
        $("#chat-lock-btn").hide();
      } else {
        $("#chat-lock-btn")
          .show()
          .off("click")
          .on("click", function () {
            promptSetChatLock(user, null);
          });
      }

      messages.forEach(function (msg) {
        showMessage(
          msg.senderName,
          msg.content,
          msg.senderName === currentUsername,
          user === "public",
          msg.messageType || "TEXT",
          msg.id,
          msg.edited,
          msg.delivered,
          msg.read,
          msg.deliveredAt,
          msg.readAt,
          msg.replyToId,
          msg.replyToContent,
          msg.replyToSender,
          false,
          msg.reactions,
          msg.forwardedFrom,
          msg.pinned,
          msg.fileName,
          msg.fileSize,
          msg.mimeType,
        );

        // Send read ACK for unread messages if it's from the other person
        if (
          user !== "public" &&
          msg.senderName !== currentUsername &&
          !msg.read
        ) {
          stompClient.send(
            "/app/message-read",
            {},
            JSON.stringify({ id: msg.id, senderName: currentUsername }),
          );
        }
      });

      if (user !== "public") {
        updateChatLockStatus(user, null);
      }
    },
    error: function (xhr) {
      if (xhr.status === 403 && xhr.responseJSON && xhr.responseJSON.locked) {
        $("#chatLockOverlay").css("display", "flex");
        $("#chatLockPasswordInput").val("").focus();
        $("#removeChatLockBtn").show();
        $("#chat-lock-btn").hide();
      }
    },
  });
}

/* ---- Chat Lock ---- */
var lockTargetUser = null;
var lockTargetGroup = null;

function promptSetChatLock(targetUser, targetGroup) {
  lockTargetUser = targetUser;
  lockTargetGroup = targetGroup;
  $("#setChatLockInput").val("");
  $("#setChatLockModal").css("display", "flex");
  if (window.innerWidth > 768) {
    $("#setChatLockInput").focus();
  }
}

function closeSetChatLockModal() {
  $("#setChatLockModal").hide();
  lockTargetUser = null;
  lockTargetGroup = null;
}

function submitSetChatLock() {
  var pw = $("#setChatLockInput").val();
  if (!pw) return;
  if (pw.length < 4) {
    showToast("PIN / Password too short! (min 4)", "error");
    return;
  }
  $.ajax({
    url: "/api/chat-lock/set",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify({
      targetUsername: lockTargetUser,
      targetGroupId: lockTargetGroup,
      password: pw,
    }),
    success: function () {
      showToast("Chat locked successfully", "success");
      updateChatLockStatus(lockTargetUser, lockTargetGroup);
      closeSetChatLockModal();
    },
    error: function (xhr) {
      showToast("Failed to lock chat", "error");
    },
  });
}

function addPinChar(inputId, char) {
  var input = document.getElementById(inputId);
  input.value = input.value + char;
}

function removePinChar(inputId) {
  var input = document.getElementById(inputId);
  input.value = input.value.slice(0, -1);
}

function verifyChatLock() {
  var pw = $("#chatLockPasswordInput").val();
  if (!pw) return;

  var data = {};
  if (activeGroupId) {
    data.targetGroupId = activeGroupId;
  } else if (selectedUser && selectedUser !== "public") {
    data.targetUsername = selectedUser;
  }
  data.password = pw;

  $.ajax({
    url: "/api/chat-lock/verify",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify(data),
    success: function () {
      $("#chatLockOverlay").hide();
      if (activeGroupId) loadGroupHistory(activeGroupId);
      else loadChatHistory(selectedUser);
    },
    error: function () {
      showToast("Incorrect password!", "error");
    },
  });
}

function removeChatLock() {
  var pw = $("#chatLockPasswordInput").val();
  if (!pw) {
    showToast("Enter password to remove lock", "error");
    return;
  }

  var data = {};
  if (activeGroupId) data.targetGroupId = activeGroupId;
  else if (selectedUser && selectedUser !== "public")
    data.targetUsername = selectedUser;
  data.password = pw;

  $.ajax({
    url: "/api/chat-lock/remove",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify(data),
    success: function () {
      $("#chatLockOverlay").hide();
      showToast("Chat lock removed", "success");
      if (activeGroupId) loadGroupHistory(activeGroupId);
      else loadChatHistory(selectedUser);
    },
    error: function () {
      showToast("Incorrect password", "error");
    },
  });
}

function updateChatLockStatus(targetUser, targetGroup) {
  var url = "/api/chat-lock/status?";
  if (targetUser) url += "targetUsername=" + encodeURIComponent(targetUser);
  if (targetGroup) url += "targetGroupId=" + targetGroup;

  $.get(url, function (status) {
    var btn = $("#chat-lock-btn");
    if (status.locked) {
      btn
        .html('<i class="fi fi-sr-lock" style="color:var(--clr-primary);"></i>')
        .attr("title", "Chat is locked");
      btn.off("click").on("click", function () {
        // Show lock overlay for remove
        $("#chatLockPasswordInput").val("").focus();
        $("#removeChatLockBtn").show();
        $("#chatLockOverlay").css("display", "flex");
      });
    } else {
      btn.html('<i class="fi fi-rr-lock"></i>').attr("title", "Lock Chat");
      btn.off("click").on("click", function () {
        promptSetChatLock(targetUser, targetGroup);
      });
    }
  });
}

function sendMessage() {
  var messageContent = $("#messageInput").val().trim();
  if (!messageContent || !stompClient) return;

  if (messageContent.length > MAX_MESSAGE_LENGTH) {
    showToast(
      "Mesaj çox uzundur (maksimum " + MAX_MESSAGE_LENGTH + " simvol).",
      "error",
    );
    return;
  }

  var chatMessage = {
    senderName: currentUsername,
    message: messageContent,
    status: "MESSAGE",
    messageType: "TEXT",
  };

  // Attach reply data if replying
  if (replyToId) {
    chatMessage.replyToId = replyToId;
    chatMessage.replyToContent = replyToContent;
    chatMessage.replyToSender = replyToSender;
  }

  if (selectedUser === "public") {
    stompClient.send("/app/message", {}, JSON.stringify(chatMessage));
  } else if (activeGroupId != null) {
    chatMessage.groupId = activeGroupId;
    stompClient.send("/app/group-message", {}, JSON.stringify(chatMessage));
  } else {
    chatMessage.receiverName = selectedUser;
    stompClient.send("/app/private-message", {}, JSON.stringify(chatMessage));
  }
  $("#messageInput").val("");
  clearReply();
}

function sendAudioMessage(url) {
  if (!url || !stompClient || selectedUser === "public" || activeGroupId != null) return;

  var chatMessage = {
    senderName: currentUsername,
    receiverName: selectedUser,
    message: url,
    status: "MESSAGE",
    messageType: "AUDIO",
  };
  if (replyToId) {
    chatMessage.replyToId = replyToId;
    chatMessage.replyToContent = replyToContent;
    chatMessage.replyToSender = replyToSender;
  }
  stompClient.send("/app/private-message", {}, JSON.stringify(chatMessage));
  clearReply();
}

function sendFileMessage(url, fileName, fileSize, mimeType) {
  if (!url || !stompClient) return;

  var chatMessage = {
    senderName: currentUsername,
    message: url,
    status: "MESSAGE",
    messageType: "FILE",
    fileName: fileName,
    fileSize: fileSize,
    mimeType: mimeType || "",
  };
  if (replyToId) {
    chatMessage.replyToId = replyToId;
    chatMessage.replyToContent = replyToContent;
    chatMessage.replyToSender = replyToSender;
  }
  if (selectedUser === "public") {
    stompClient.send("/app/message", {}, JSON.stringify(chatMessage));
  } else if (activeGroupId != null) {
    chatMessage.groupId = activeGroupId;
    stompClient.send("/app/group-message", {}, JSON.stringify(chatMessage));
  } else {
    chatMessage.receiverName = selectedUser;
    stompClient.send("/app/private-message", {}, JSON.stringify(chatMessage));
  }
  clearReply();
}

function clearReply() {
  replyToId = null;
  replyToContent = null;
  replyToSender = null;
  $("#replyPreviewBar").hide();
  $("#replyPreviewSender").text("");
  $("#replyPreviewContent").text("");
}

/* ==============================================
   THREAD PANEL
   ============================================== */
function openThreadPanel(messageId) {
  if (!messageId) return;
  currentThreadRootId = messageId;

  // Close right sidebar if open
  $("#right-sidebar").removeClass("open");
  $("#right-sidebar-backdrop").removeClass("show");

  $("#threadPanel").addClass("open");
  threadPanelOpen = true;

  loadThread(messageId);
}

function closeThreadPanel() {
  $("#threadPanel").removeClass("open");
  threadPanelOpen = false;
  currentThreadRootId = null;
}

function loadThread(messageId) {
  var container = $("#threadMessages");
  container.html('<div class="tp-loading">Loading thread...</div>');

  $.get("/api/messages/" + messageId + "/thread", function (messages) {
    if (!messages || messages.length === 0) {
      container.html('<div class="tp-empty">No messages in thread</div>');
      return;
    }

    var html = "";

    // Root message
    var root = messages[0];
    var rootTime = formatTime(root.timestamp);
    html += '<div class="tp-root-msg">';
    html += '<div class="tp-root-sender">' + escapeHtml(root.senderName) + "</div>";
    html += '<div class="tp-root-text">' + escapeHtml(root.content) + "</div>";
    html += '<div class="tp-root-time">' + rootTime + "</div>";
    html += "</div>";

    // Replies
    if (messages.length > 1) {
      html += '<div class="tp-divider">' + (messages.length - 1) + " replies</div>";
    }

    for (var i = 1; i < messages.length; i++) {
      var m = messages[i];
      var t = formatTime(m.timestamp);
      html += '<div class="tp-reply-item" id="tp-reply-' + m.id + '">';

      if (m.replyToId && m.replyToContent) {
        html += '<div class="tp-reply-quote" onclick="var el=document.getElementById(\'msg-' + m.replyToId + '\');if(el)el.scrollIntoView({behavior:\'smooth\',block:\'center\'});">' + escapeHtml(m.replyToSender || "Reply") + ": " + escapeHtml(m.replyToContent) + "</div>";
      }

      html += '<div class="tp-reply-sender">' + escapeHtml(m.senderName) + "</div>";
      html += '<div class="tp-reply-text">' + escapeHtml(m.content) + "</div>";
      html += '<div class="tp-reply-time">' + t + "</div>";
      html += "</div>";
    }

    container.html(html);
    container.scrollTop(container[0].scrollHeight);
  }).fail(function () {
    container.html('<div class="tp-empty">Failed to load thread</div>');
  });
}

function checkThreadMessage(msg) {
  if (!threadPanelOpen || !currentThreadRootId) return;
  var replyId = msg.replyToId;
  if (!replyId) return;
  // Check if this reply belongs to our current thread
  if (replyId === currentThreadRootId || replyId === Number(currentThreadRootId)) {
    loadThread(currentThreadRootId);
  }
}

function formatTime(ts) {
  if (!ts) return "";
  try {
    var d = new Date(ts);
    if (isNaN(d.getTime())) {
      // Try ISO format
      var parts = ts.split("T");
      if (parts.length > 1) {
        var timePart = parts[1].split(".")[0];
        return timePart.substring(0, 5);
      }
      return ts;
    }
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return ts;
  }
}

function sendThreadReply() {
  var input = $("#threadInput");
  var text = input.val().trim();
  if (!text || !stompClient || !currentThreadRootId) return;

  // Fetch root message for reply quote context
  $.get("/api/messages/" + currentThreadRootId + "/thread", function (messages) {
    var root = messages && messages.length > 0 ? messages[0] : null;

    var chatMessage = {
      senderName: currentUsername,
      message: text,
      status: "MESSAGE",
      messageType: "TEXT",
      replyToId: currentThreadRootId,
    };

    if (root) {
      chatMessage.replyToContent = root.content || "";
      chatMessage.replyToSender = root.senderName || "";
    }

    if (selectedUser === "public") {
      stompClient.send("/app/message", {}, JSON.stringify(chatMessage));
    } else if (activeGroupId != null) {
      chatMessage.groupId = activeGroupId;
      stompClient.send("/app/group-message", {}, JSON.stringify(chatMessage));
    } else {
      chatMessage.receiverName = selectedUser;
      stompClient.send("/app/private-message", {}, JSON.stringify(chatMessage));
    }
    input.val("");
    input.focus();
  }).fail(function () {
    // Fallback without reply context
    var chatMessage = {
      senderName: currentUsername,
      message: text,
      status: "MESSAGE",
      messageType: "TEXT",
      replyToId: currentThreadRootId,
    };
    if (selectedUser === "public") {
      stompClient.send("/app/message", {}, JSON.stringify(chatMessage));
    } else if (activeGroupId != null) {
      chatMessage.groupId = activeGroupId;
      stompClient.send("/app/group-message", {}, JSON.stringify(chatMessage));
    } else {
      chatMessage.receiverName = selectedUser;
      stompClient.send("/app/private-message", {}, JSON.stringify(chatMessage));
    }
    input.val("");
    input.focus();
  });
}

/* ==============================================
   TYPING INDICATOR
   ============================================== */
var typingTimeout = null;
var typingSender = null;

function handleTypingIndicator(senderName, isTyping, messageType) {
  if (selectedUser !== senderName) return;

  if (isTyping) {
    typingSender = senderName;
    var labelText =
      messageType === "AUDIO" ? "recording audio..." : "typing...";
    $("#selectedUserInfo").html(
      '<span class="typing-indicator"><span></span><span></span><span></span></span> <span class="typing-text">' +
        labelText +
        "</span>",
    );
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(function () {
      $("#selectedUserInfo").text("@" + senderName + " · Private chat");
      typingSender = null;
    }, 3000);
  } else {
    if (typingSender === senderName) {
      $("#selectedUserInfo").text("@" + senderName + " · Private chat");
      typingSender = null;
      clearTimeout(typingTimeout);
    }
  }
}

function sendTypingEvent(isTyping, messageType) {
  if (!stompClient || selectedUser === "public" || activeGroupId != null)
    return;
  var payload = {
    senderName: currentUsername,
    receiverName: selectedUser,
    typing: isTyping,
  };
  if (messageType) {
    payload.messageType = messageType;
  }
  stompClient.send("/app/typing", {}, JSON.stringify(payload));
}

// Typing debounce - send typing on input, stop after 2s of no typing
var typingDebounce = null;
$(document).ready(function () {
  $("#messageInput").on("input", function () {
    if (selectedUser === "public" || activeGroupId != null) return;
    sendTypingEvent(true);
    clearTimeout(typingDebounce);
    typingDebounce = setTimeout(function () {
      sendTypingEvent(false);
    }, 2000);
  });
});

/* ==============================================
   PRESENCE AUTO-REFRESH
   ============================================== */
function updateContactPresence(username, isOnline, presenceText) {
  var item = $("#contact-item-" + username);
  if (item.length === 0) return;
  var lastMsg = item.find(".contact_last_msg");
  if (lastMsg.length) lastMsg.text(presenceText);

  var nameEl = item.find(".cr-contact-name");
  var dot = nameEl.find(".cr-contact-online-dot");
  if (isOnline) {
    if (dot.length === 0)
      nameEl.append('<span class="cr-contact-online-dot"></span>');
    else dot.removeClass("cr-contact-offline-dot");
  } else {
    if (dot.length === 0)
      nameEl.append(
        '<span class="cr-contact-online-dot cr-contact-offline-dot"></span>',
      );
    else dot.addClass("cr-contact-offline-dot");
  }
}

// Periodic presence refresh every 30 seconds
var presenceRefreshInterval = null;
$(document).ready(function () {
  presenceRefreshInterval = setInterval(function () {
    $.get("/api/contacts", function (data) {
      (data || []).forEach(function (contact) {
        var presenceText =
          contact.online === "true" ? "Online" : contact.presence || "Offline";
        updateContactPresence(
          contact.username,
          contact.online === "true",
          presenceText,
        );
      });
    });
  }, 30000);
});

function startVoiceRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("Your browser does not support audio recording", "error");
    return;
  }
  if (selectedUser === "public" || activeGroupId != null) {
    showToast("Voice messages are only available in private chats", "info");
    return;
  }
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then(function (stream) {
      activeAudioStream = stream;
      audioChunks = [];
      recordingSeconds = 0;
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function (e) {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = function () {
        clearInterval(recordingTimer);
        var blob = new Blob(audioChunks, { type: "audio/webm" });

        // Clean up UI
        $("#messageInput").show();
        $("#emojiBtn").show();
        $("#attachmentToggleBtn").show();
        $("#voice-recording-bar").hide();
        $("#sendButton").removeClass("recording-active");
        isRecording = false;
        updateSendBtnMode();
        sendTypingEvent(false);

        // Limit audio size to 5MB
        if (blob.size > 5 * 1024 * 1024) {
          showToast("Voice message is too large (Max 5MB).", "error");
          if (activeAudioStream) {
            activeAudioStream.getTracks().forEach(function (t) {
              t.stop();
            });
            activeAudioStream = null;
          }
          return;
        }

        var audioFormData = new FormData();
        audioFormData.append("file", blob, "voice.webm");
        audioFormData.append("to", selectedUser);
        $.ajax({
          url: "/api/upload",
          method: "POST",
          data: audioFormData,
          processData: false,
          contentType: false,
          success: function (data) {
            sendAudioMessage(data.url);
          },
          error: function () {
            showToast("Failed to upload voice message", "error");
          },
        });
        if (activeAudioStream) {
          activeAudioStream.getTracks().forEach(function (t) {
            t.stop();
          });
          activeAudioStream = null;
        }
      };
      mediaRecorder.start(100);
      isRecording = true;

      // Hide normal input controls
      $("#messageInput").hide();
      $("#emojiBtn").hide();
      $("#attachmentToggleBtn").hide();

      // Show recording bar with label
      $("#voice-recording-bar").css("display", "flex");
      $("#voiceRecTimer").text("1:00");
      $(".voice-rec-label").text("Slide to cancel  ·  1:00 remaining");

      // Toggle send button appearance to stop square
      $("#sendButton").addClass("recording-active");
      $("#sendBtnIcon")
        .removeClass("fi-sr-microphone")
        .addClass("fi-sr-square");

      // Notify typing status
      sendTypingEvent(true, "AUDIO");

      // Tick second-by-second, countdown from 60
      recordingTimer = setInterval(function () {
        recordingSeconds++;
        var remaining = 60 - recordingSeconds;
        var elapsed_m = Math.floor(recordingSeconds / 60);
        var elapsed_s = recordingSeconds % 60;
        var elapsedStr =
          elapsed_m + ":" + (elapsed_s < 10 ? "0" : "") + elapsed_s;
        $("#voiceRecTimer").text(elapsedStr);
        if (remaining <= 0) {
          stopVoiceRecording();
        } else {
          var rem_m = Math.floor(remaining / 60);
          var rem_s = remaining % 60;
          var remStr = rem_m + ":" + (rem_s < 10 ? "0" : "") + rem_s;
          $(".voice-rec-label").text(
            "Tap \u25a0 to send  ·  " + remStr + " remaining",
          );
        }
      }, 1000);
    })
    .catch(function () {
      showToast("Microphone access denied", "error");
    });
}

function stopVoiceRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
  }
}

function cancelVoiceRecording() {
  if (mediaRecorder && isRecording) {
    // Change onstop to just clean up without sending
    mediaRecorder.onstop = function () {
      clearInterval(recordingTimer);
      audioChunks = [];
      if (activeAudioStream) {
        activeAudioStream.getTracks().forEach(function (t) {
          t.stop();
        });
        activeAudioStream = null;
      }
    };
    mediaRecorder.stop();
    isRecording = false;
    clearInterval(recordingTimer);

    // Show/hide UI elements
    $("#messageInput").show();
    $("#emojiBtn").show();
    $("#attachmentToggleBtn").show();
    $("#voice-recording-bar").hide();

    // Reset send button
    $("#sendButton").removeClass("recording-active");
    updateSendBtnMode();

    // Send typing indicator false
    sendTypingEvent(false);
    showToast("Recording cancelled", "info");
  }
}

// ---- Custom Voice Player ----
function initVoicePlayer(playerId) {
  var container = document.getElementById(playerId);
  if (!container) return;

  var audio = container.querySelector("audio");
  var playBtn = container.querySelector(".vp-play-btn");
  var iconPlay = container.querySelector(".vp-icon-play");
  var iconPause = container.querySelector(".vp-icon-pause");
  var bars = container.querySelectorAll(".vp-bar");
  var progressEl = container.querySelector(".vp-progress");
  var timeEl = container.querySelector(".vp-time");
  var waveform = container.querySelector(".vp-waveform");
  var totalBars = bars.length;
  var rafId = null;

  function formatTime(s) {
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function updateProgress() {
    if (!audio.duration) return;
    var pct = audio.currentTime / audio.duration;
    progressEl.style.width = pct * 100 + "%";
    timeEl.textContent = formatTime(audio.currentTime);
    var activeBars = Math.round(pct * totalBars);
    bars.forEach(function (b, i) {
      b.classList.toggle("vp-bar--active", i < activeBars);
    });
    if (!audio.paused) rafId = requestAnimationFrame(updateProgress);
  }

  audio.addEventListener("loadedmetadata", function () {
    timeEl.textContent = formatTime(audio.duration);
  });

  audio.addEventListener("ended", function () {
    cancelAnimationFrame(rafId);
    iconPlay.style.display = "";
    iconPause.style.display = "none";
    playBtn.classList.remove("vp-playing");
    timeEl.textContent = formatTime(audio.duration || 0);
    progressEl.style.width = "0%";
    bars.forEach(function (b) {
      b.classList.remove("vp-bar--active");
    });
  });

  playBtn.addEventListener("click", function () {
    // Pause all other players first
    document.querySelectorAll(".voice-player audio").forEach(function (a) {
      if (a !== audio && !a.paused) {
        a.pause();
        var c = a.closest(".voice-player");
        if (c) {
          c.querySelector(".vp-icon-play").style.display = "";
          c.querySelector(".vp-icon-pause").style.display = "none";
          c.querySelector(".vp-play-btn").classList.remove("vp-playing");
        }
      }
    });

    if (audio.paused) {
      audio.play();
      iconPlay.style.display = "none";
      iconPause.style.display = "";
      playBtn.classList.add("vp-playing");
      rafId = requestAnimationFrame(updateProgress);
    } else {
      audio.pause();
      cancelAnimationFrame(rafId);
      iconPlay.style.display = "";
      iconPause.style.display = "none";
      playBtn.classList.remove("vp-playing");
    }
  });

  // Seek on waveform click
  waveform.addEventListener("click", function (e) {
    if (!audio.duration) return;
    var rect = waveform.getBoundingClientRect();
    var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
    updateProgress();
  });
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "";
  var units = ["B", "KB", "MB", "GB"];
  var i = 0;
  var size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function showMessage(
  sender,
  messageText,
  isSender,
  isPublic,
  messageType,
  messageId,
  isEdited,
  isDelivered,
  isRead,
  deliveredAt,
  readAt,
  replyId,
  replyContent,
  replySender,
  isGroupChat,
  reactions,
  forwardedFrom,
  pinned,
  fileName,
  fileSize,
  mimeType,
  readBy,
) {
  var time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  var inGroupChat = !!isGroupChat;

  // System messages (join/leave group)
  if (messageType === "SYSTEM_JOIN" || messageType === "SYSTEM_LEAVE") {
    var sysRow = $(
      '<div class="chat-msg-row chat-msg-row--system" id="msg-' +
        messageId +
        '"></div>',
    );
    sysRow.append(
      '<div class="msg-system-bubble">' + (messageText || "") + "</div>",
    );
    $("#chatMessages").append(sysRow);
    var el = document.getElementById("chatMessages");
    el.scrollTop = el.scrollHeight;
    return;
  }

  var rowIdAttr = messageId ? 'id="msg-' + messageId + '"' : "";
  var dataAttrs = "";
  if (deliveredAt) dataAttrs += ' data-delivered-at="' + deliveredAt + '"';
  if (readAt) dataAttrs += ' data-read-at="' + readAt + '"';

  var row = $(
    '<div class="chat-msg-row ' +
      (isSender ? "from-me" : "from-them") +
      '" ' +
      rowIdAttr +
      ' data-sender="' +
      sender +
      '"' +
      dataAttrs +
      "></div>",
  );

  var avatarEl = $(
    '<div class="msg-avatar" style="cursor:pointer;"></div>',
  ).html(
    isSender
      ? '<div style="width:30px;height:30px;border-radius:50%;background:' +
          getAvatarColor(currentUsername) +
          ';display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;">' +
          getInitial(currentUsername) +
          "</div>"
      : '<div style="width:30px;height:30px;border-radius:50%;background:' +
          getAvatarColor(sender) +
          ';display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;">' +
          getInitial(sender) +
          "</div>",
  );

  var contentEl = $('<div class="msg-content"></div>');
  if (!isSender) {
    contentEl.append(
      '<div class="msg-sender-name">' + escapeHtml(sender) + "</div>",
    );
  }

  // Add Reply Quote if it exists
  if (replyId && replyContent && replySender) {
    var quoteEl = $('<div class="msg-reply-quote"></div>');
    quoteEl.on("click", function () {
      openThreadPanel(replyId);
    });
    quoteEl.append(
      '<div class="msg-reply-quote-sender">' +
        escapeHtml(replySender) +
        "</div>",
    );
    quoteEl.append(
      '<div class="msg-reply-quote-text">' +
        escapeHtml(replyContent) +
        "</div>",
    );
    contentEl.append(quoteEl);
  }

  // Forwarded label
  if (forwardedFrom) {
    contentEl.append('<div class="msg-forwarded-label"><i class="fi fi-rr-share"></i> Forwarded</div>');
  }

  if (messageType === "IMAGE") {
    var bubbleEl = $(
      '<div class="msg-bubble msg-image" style="padding: 5px; background: transparent;"></div>',
    );
    bubbleEl.append(
      '<img src="' +
        messageText +
        '" style="max-width: 250px; border-radius: 12px; display: block;" alt="Image"/>',
    );
    contentEl.append(bubbleEl);
  } else if (messageType === "FILE") {
    var mt = (mimeType || "").toLowerCase();
    if (mt.indexOf("image/") === 0) {
      var bubbleEl = $(
        '<div class="msg-bubble msg-image" style="padding: 5px; background: transparent;"></div>',
      );
      bubbleEl.append(
        '<img src="' + messageText + '" style="max-width: 250px; border-radius: 12px; display: block;" alt="' + escapeHtml(fileName || "Image") + '"/>',
      );
      contentEl.append(bubbleEl);
    } else {
      var displayName = fileName || "file";
      var displaySize = fileSize ? formatFileSize(fileSize) : "";
      var ext = displayName.lastIndexOf(".") > 0 ? displayName.split(".").pop().toUpperCase() : "FILE";
      if (ext.length > 6) ext = "FILE";
      var bubbleEl = $(
        '<div class="msg-bubble msg-file"><div class="file-card">' +
          '<div class="file-card-icon">' + escapeHtml(ext) + '</div>' +
          '<div class="file-card-info">' +
            '<div class="file-card-name">' + escapeHtml(displayName) + '</div>' +
            '<div class="file-card-meta">' +
              (displaySize ? escapeHtml(displaySize) : "") +
            '</div>' +
          '</div>' +
          '<a class="file-card-download" href="' + messageText + '" target="_blank" title="Download" download="' + escapeHtml(displayName) + '">' +
            '<i class="fi fi-rr-download"></i>' +
          '</a>' +
        '</div></div>',
      );
      contentEl.append(bubbleEl);
    }
  } else if (messageType === "AUDIO") {
    var playerId = "vp-" + (messageId || Date.now());
    var bubbleEl = $('<div class="msg-bubble msg-audio"></div>');
    bubbleEl.html(
      '<div class="voice-player" id="' +
        playerId +
        '">' +
        '<button class="vp-play-btn" aria-label="Play voice message">' +
        '<i class="fi fi-rr-play vp-icon-play"></i>' +
        '<i class="fi fi-rr-pause vp-icon-pause" style="display:none;"></i>' +
        "</button>" +
        '<div class="vp-waveform">' +
        '<div class="vp-bars">' +
        Array.from({ length: 28 }, function (_, i) {
          var h = [
            30, 45, 60, 80, 55, 70, 40, 90, 65, 50, 75, 35, 85, 60, 45, 70, 55,
            80, 40, 65, 50, 75, 35, 60, 45, 80, 55, 40,
          ][i % 28];
          return '<span class="vp-bar" style="height:' + h + '%"></span>';
        }).join("") +
        "</div>" +
        '<div class="vp-progress"></div>' +
        "</div>" +
        '<span class="vp-time">0:00</span>' +
        '<audio src="' +
        messageText +
        '" preload="metadata"></audio>' +
        "</div>",
    );
    contentEl.append(bubbleEl);
    // Wire up player after DOM insertion (deferred so element exists)
    setTimeout(function () {
      initVoicePlayer(playerId);
    }, 0);
  } else if (messageType === "CALL_LOG") {
    var callData;
    try { callData = JSON.parse(messageText); } catch (e) { callData = {}; }
    var isMissed = callData.status === "missed";
    var callIcon = callData.callType === "audio" ? "fi fi-rr-phone-call" : "fi fi-rr-video-camera";
    var durationStr = "";
    if (!isMissed && callData.durationSeconds != null) {
      var mins = Math.floor(callData.durationSeconds / 60);
      var secs = callData.durationSeconds % 60;
      durationStr = " · " + mins + ":" + (secs < 10 ? "0" : "") + secs;
    }
    var bubbleEl = $(
      '<div class="msg-bubble msg-call-log ' + (isMissed ? "msg-call-missed" : "msg-call-answered") + '">' +
        '<i class="msg-call-icon ' + callIcon + '"></i>' +
        '<span class="msg-call-label">' +
          (isMissed ? "Missed " : "") +
          (callData.callType === "audio" ? "Audio call" : "Video call") +
          durationStr +
        '</span>' +
      '</div>'
    );
    contentEl.append(bubbleEl);
  } else {
    var bubbleEl = $('<div class="msg-bubble"></div>').text(messageText);
    if (isEdited) {
      bubbleEl.append('<span class="msg-edited-label">(edited)</span>');
    }
    contentEl.append(bubbleEl);
  }

  var metaHtml = time;
  if (pinned) {
    metaHtml += ' <span class="msg-pin-indicator"><i class="fi fi-rr-thumbtack"></i></span>';
  }
  if (!isPublic && isSender && !inGroupChat) {
    var receiptClass = isRead ? "read" : isDelivered ? "delivered" : "";
    var receiptIcon = isRead || isDelivered ? "✓✓" : "✓";
    metaHtml +=
      ' <span class="msg-receipts ' +
      receiptClass +
      '">' +
      receiptIcon +
      "</span>";
  }
  if (!isPublic && isSender && inGroupChat && readBy && readBy.length > 0) {
    metaHtml += ' <span class="msg-group-read-receipts" title="Read by ' + readBy.join(', ') + '"><i class="fi fi-rr-check-double"></i> ' + readBy.length + '</span>';
  }

  contentEl.append('<div class="msg-meta">' + metaHtml + "</div>");

  // Reaction pills container (always present so we can update it later)
  var reactionsEl = $(
    '<div class="msg-reactions" data-msg-id="' + messageId + '"></div>',
  );
  contentEl.append(reactionsEl);
  if (reactions && reactions.length > 0) {
    renderReactionPills(reactionsEl, reactions, messageId);
  }

  if (messageId) {
    bindContextMenu(row, messageId, isSender);
  }

  if (isSender && messageId) {
    var checkboxWrapper = $(
      '<div style="display:flex;align-items:center;"></div>',
    );
    var checkbox = $(
      '<input type="checkbox" class="msg-checkbox" value="' + messageId + '"/>',
    );
    checkbox.on("change", function (e) {
      updateBulkSelection();
    });
    checkboxWrapper.append(checkbox);
    row.append(checkboxWrapper);

    row.on("click", function (e) {
      if (
        $("#chat-body").hasClass("selection-mode") &&
        !$(e.target).is('input[type="checkbox"]')
      ) {
        var cb = $(this).find(".msg-checkbox");
        if (cb.length > 0) {
          cb.prop("checked", !cb.prop("checked"));
          updateBulkSelection();
        }
      }
    });
  }

  row.append(avatarEl).append(contentEl);
  $("#chatMessages").append(row);

  var el = document.getElementById("chatMessages");
  el.scrollTop = el.scrollHeight;
}

// Bulk Selection UI Logic
function updateBulkSelection() {
  var checked = $(".msg-checkbox:checked").length;
  $("#bulk-selected-count").text(checked + " selected");
  if (checked > 0) {
    $("#confirm-bulk-btn").removeAttr("disabled").css("opacity", "1");
  } else {
    $("#confirm-bulk-btn").attr("disabled", "disabled").css("opacity", "0.5");
  }
}

$(document).ready(function () {
  $("#bulk-delete-toggle").on("click", function () {
    var body = $("#chat-body");
    if (body.hasClass("selection-mode")) {
      body.removeClass("selection-mode");
      $(".msg-checkbox").prop("checked", false);
    } else {
      body.addClass("selection-mode");
      updateBulkSelection();
    }
  });

  $("#cancel-bulk-btn").on("click", function () {
    $("#chat-body").removeClass("selection-mode");
    $(".msg-checkbox").prop("checked", false);
  });

  $("#confirm-bulk-btn").on("click", function () {
    var checkedIds = [];
    $(".msg-checkbox:checked").each(function () {
      checkedIds.push($(this).val());
    });

    if (checkedIds.length === 0) return;

    openDeleteConfirmModal(null, true, checkedIds.length);
  });
});

function updateLastMsg(username, text) {
  var preview = text.length > 24 ? text.substring(0, 24) + "…" : text;
  $("#last-msg-" + username).text(preview);
}

/* ==============================================
   PUBLIC CHAT INVITE
   ============================================== */
function sendInviteToPublicUser(targetUsername) {
  if (!targetUsername || targetUsername === currentUsername) return;

  // Check if already a contact
  var existingItem = document.getElementById("contact-item-" + targetUsername);
  if (existingItem) {
    showToast(targetUsername + " is already in your contacts", "info");
    return;
  }

  // Generate token and immediately accept it as if the target person sent it
  // Since this is a single-user action (we initiate), we just generate + accept our own invite
  // But the real flow: generate invite link and copy it (they'd have to click it)
  // A simpler approach: use a special "direct add" endpoint if we want one-sided add.
  // For now: generate token, display it as toast with copy option
  $.post("/api/invite/generate", function (data) {
    var link = window.location.origin + "/invite/" + data.token;
    copyToClipboard(link);
    showToast(
      "Invite link for " + targetUsername + " copied! Send it to them.",
      "success",
    );
  }).fail(function () {
    showToast("Failed to generate invite link", "info");
  });
}

function copyToClipboard(text) {
  var el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.top = "-999px";
  el.style.left = "-999px";
  document.body.appendChild(el);
  el.select();
  try {
    document.execCommand("copy");
  } catch (e) {
    console.error("Copy failed", e);
  }
  document.body.removeChild(el);
}

/* ==============================================
   CONTACT HOVER TOOLTIP
   ============================================== */
var tooltipTimeout = null;
var tooltipTarget = null;

function initTooltip() {
  $(document)
    .off("mouseenter.tooltip", "#chatMessages .msg-avatar")
    .on("mouseenter.tooltip", "#chatMessages .msg-avatar", function (e) {
      var item = $(this).closest(".chat-msg-row");
      var senderName = item.data("sender");
      if (!senderName || senderName === currentUsername) return; // Ignore ourselves

      tooltipTarget = item;
      clearTimeout(tooltipTimeout);
      tooltipTimeout = setTimeout(function () {
        showTooltipFromMessage(item, senderName, e.currentTarget);
      }, 280);
    });

  $(document)
    .off("mouseleave.tooltip", "#chatMessages .msg-avatar")
    .on("mouseleave.tooltip", "#chatMessages .msg-avatar", function () {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = setTimeout(hideTooltip, 220);
    });

  $("#cr-contact-tooltip")
    .on("mouseenter", function () {
      clearTimeout(tooltipTimeout);
    })
    .on("mouseleave", function () {
      tooltipTimeout = setTimeout(hideTooltip, 200);
    });

  // Tooltip buttons
  $("#tooltip-chat-btn")
    .off("click")
    .on("click", function () {
      if (tooltipTarget) selectUser(tooltipTarget.data("sender"));
    });
  $("#tooltip-invite-btn")
    .off("click")
    .on("click", function () {
      hideTooltip();
    });
  $("#tooltip-call-btn")
    .off("click")
    .on("click", function () {
      if (!tooltipTarget) return;
      var targetUser = tooltipTarget.data("sender");
      if (!targetUser) return;
      hideTooltip();
      if (window.initiateCall) window.initiateCall(targetUser, "audio");
    });
  $("#tooltip-video-btn")
    .off("click")
    .on("click", function () {
      if (!tooltipTarget) return;
      var targetUser = tooltipTarget.data("sender");
      if (!targetUser) return;
      hideTooltip();
      if (window.initiateCall) window.initiateCall(targetUser, "video");
    });
  $("#tooltip-block-btn")
    .off("click")
    .on("click", function () {
      if (!tooltipTarget) return;
      var targetUser = tooltipTarget.data("sender");
      if (!targetUser) return;
      var isBlocked = $(this).text().trim() === "Unblock";
      if (isBlocked) {
        unblockUser(targetUser);
      } else {
        blockUser(targetUser);
      }
      hideTooltip();
    });
}

function blockUser(targetUsername) {
  if (!targetUsername) return;
  $.ajax({
    url: "/api/blocks/" + encodeURIComponent(targetUsername),
    method: "POST",
    success: function () {
      showToast("Blocked @" + targetUsername, "info");
      fetchContacts();
    },
    error: function (xhr) {
      showToast(xhr.responseText || "Failed to block user", "error");
    },
  });
}

function unblockUser(targetUsername) {
  if (!targetUsername) return;
  $.ajax({
    url: "/api/blocks/" + encodeURIComponent(targetUsername),
    method: "DELETE",
    success: function () {
      showToast("Unblocked @" + targetUsername, "success");
      fetchContacts();
    },
    error: function (xhr) {
      showToast(xhr.responseText || "Failed to unblock user", "error");
    },
  });
}

function showTooltipFromMessage(row, username, avatarEl) {
  var fullname = username;
  var isContact = $("#contact-item-" + username).length > 0;

  var contactItem = $("#contact-item-" + username);
  var avatarSrc = "";
  if (contactItem.length > 0) {
    fullname = contactItem.data("fullname") || username;
    avatarSrc = contactItem.data("avatar");
  }

  if (avatarSrc) {
    $("#tooltip-avatar").html(
      '<img src="' +
        avatarSrc +
        '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>',
    );
  } else {
    $("#tooltip-avatar")
      .css("background", getAvatarColor(username))
      .text(getInitial(fullname));
  }
  $("#tooltip-name").text(fullname);
  $("#tooltip-username").text("@" + username);

  if (isContact) {
    $("#tooltip-invite-btn").hide();
    $("#tooltip-chat-btn").show().html('<i class="fi fi-sr-comment-dots"></i> Chat');
    $("#tooltip-call-btn, #tooltip-video-btn").show();
  } else {
    $("#tooltip-invite-btn").hide();
    $("#tooltip-call-btn, #tooltip-video-btn").hide();
  }

  // Fetch user info for bio, block status, and privacy
  $.get("/api/users/" + username, function (info) {
    var bioText = info.bio || "";
    $("#tooltip-bio").text(bioText).toggle(!!bioText);

    if (username !== currentUsername) {
      var blocked = info.blocked;
      $("#tooltip-block-btn")
        .show()
        .html(blocked ? '<i class="fi fi-rr-check"></i> Unblock' : '<i class="fi fi-rr-ban"></i> Block')
        .removeClass("tooltip-btn-danger")
        .toggleClass("tooltip-btn-unblock", !!blocked);
    } else {
      $("#tooltip-block-btn").hide();
    }

    // Button control
    if (username !== currentUsername) {
      $("#tooltip-chat-btn").show().html('<i class="fi fi-sr-comment-dots"></i> Chat');
      $("#tooltip-invite-btn").hide();
    }
  }).fail(function () {
    $("#tooltip-bio").hide();
    if (username !== currentUsername) {
      $("#tooltip-block-btn")
        .show()
        .html('<i class="fi fi-rr-ban"></i> Block')
        .removeClass("tooltip-btn-unblock");
    } else {
      $("#tooltip-block-btn").hide();
    }
  });

  var rect = avatarEl.getBoundingClientRect();
  var tooltip = document.getElementById("cr-contact-tooltip");

  tooltip.style.left = rect.right + 10 + "px";
  tooltip.style.top = Math.max(10, rect.top - 10) + "px";

  $("#cr-contact-tooltip").addClass("show");
}

function hideTooltip() {
  $("#cr-contact-tooltip").removeClass("show");
}

/* ==============================================
   SIDEBAR RESIZE
   ============================================== */
function initSidebarResize() {
  var handle = document.getElementById("sidebar-resize-handle");
  var sidebar = document.getElementById("chat-sidebar");
  var body = document.getElementById("chat-body");
  if (!handle || !sidebar) return;

  var isResizing = false;
  var startX, startW;

  handle.addEventListener("mousedown", function (e) {
    isResizing = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    body.classList.add("resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", function (e) {
    if (!isResizing) return;
    var dx = e.clientX - startX;
    var newW = Math.min(Math.max(startW + dx, 200), 420);
    sidebar.style.width = newW + "px";
    sidebar.style.minWidth = newW + "px";
  });

  document.addEventListener("mouseup", function () {
    if (!isResizing) return;
    isResizing = false;
    body.classList.remove("resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // Persist to localStorage
    try {
      localStorage.setItem("cr_sidebar_w", sidebar.offsetWidth);
    } catch (e) {}
  });

  // Restore saved width
  try {
    var saved = localStorage.getItem("cr_sidebar_w");
    if (saved) {
      sidebar.style.width = saved + "px";
      sidebar.style.minWidth = saved + "px";
    }
  } catch (e) {}
}

/* ==============================================
   TOAST
   ============================================== */
function showToast(msg, type) {
  type = type || "info";
  var icon = type === "success" ? "fi-sr-check-circle" : "fi-sr-info";
  var t = $(
    '<div class="cr-toast ' +
      type +
      '"><i class="fi ' +
      icon +
      '"></i><span>' +
      msg +
      "</span></div>",
  );
  $("body").append(t);
  setTimeout(function () {
    t.fadeOut(400, function () {
      t.remove();
    });
  }, 3200);
}

/* ==============================================
   EDIT MESSAGE AND RIGHT SIDEBAR
   ============================================== */
function openEditInput(messageId, bubbleEl) {
  if (bubbleEl.find(".edit-input-container").length > 0) return;

  // Get original text ignoring buttons/labels
  var clone = bubbleEl.clone();
  clone.find(".msg-edit-btn").remove();
  clone.find(".msg-edited-label").remove();
  var oldText = clone.text().trim();

  var container = $('<div class="edit-input-container"></div>');
  var input = $(
    '<input type="text" class="edit-input" value="' + oldText + '"/>',
  );
  var actions = $('<div class="edit-actions"></div>');
  var saveBtn = $('<button class="edit-btn-save">Save</button>');
  var cancelBtn = $('<button class="edit-btn-cancel">Cancel</button>');

  saveBtn.on("click", function () {
    var newText = input.val().trim();
    if (newText && newText !== oldText) {
      submitMessageEdit(messageId, newText);
    }
    container.remove();
    bubbleEl
      .contents()
      .filter(function () {
        return this.nodeType === 3;
      })
      .show();
  });

  cancelBtn.on("click", function () {
    container.remove();
    bubbleEl
      .contents()
      .filter(function () {
        return this.nodeType === 3;
      })
      .show();
  });

  // Hide original text temporarily
  bubbleEl
    .contents()
    .filter(function () {
      return this.nodeType === 3;
    })
    .hide();

  actions.append(cancelBtn).append(saveBtn);
  container.append(input).append(actions);
  bubbleEl.append(container);
  input.focus();
}

function submitMessageEdit(messageId, newText) {
  if (!stompClient) return;
  if (newText.length > MAX_MESSAGE_LENGTH) {
    showToast(
      "Mesaj çox uzundur (maksimum " + MAX_MESSAGE_LENGTH + " simvol).",
      "error",
    );
    return;
  }
  var chatMessage = {
    id: messageId,
    senderName: currentUsername,
    message: newText,
    status: "EDIT",
    messageType: "TEXT",
  };
  stompClient.send("/app/edit-message", {}, JSON.stringify(chatMessage));
}

function updateMessageBubble(messageId, newText) {
  var row = $("#msg-" + messageId);
  if (row.length === 0) return;

  var bubble = row.find(".msg-bubble");
  // Remove text nodes
  bubble
    .contents()
    .filter(function () {
      return this.nodeType === 3;
    })
    .remove();
  // Prepend new text (so it goes after the edit btn if any)
  bubble.append(document.createTextNode(newText));

  if (bubble.find(".msg-edited-label").length === 0) {
    bubble.append('<span class="msg-edited-label">(edited)</span>');
  }
}

function setRightPanelSummary(name, subtitle, opts) {
  opts = opts || {};
  var avatar = $("#rightProfileAvatar");
  $("#rightProfileName").text(name || "");
  $("#rightProfileUsername").text(subtitle || "");

  if (opts.avatarSrc) {
    avatar
      .html('<img src="' + opts.avatarSrc + '" alt=""/>')
      .css("background", "none");
    return;
  }
  if (opts.iconHtml) {
    avatar
      .html(opts.iconHtml)
      .css(
        "background",
        opts.iconBg || "linear-gradient(135deg,#2563eb,#7c3aed)",
      );
    return;
  }
  var seed = opts.seed || name || "?";
  avatar.text(getInitial(name || seed)).css("background", getAvatarColor(seed));
}

function setRightPanelInfoCard(chatType, details) {
  $("#rpPrivateInfoCard").show();
  $("#rpChatTypeValue").text(chatType || "");
  $("#rpChatDetailsValue").text(details || "");
}

function setRightPanelTab(tabName) {
  if (
    (rightPanelState.context === "group-member" ||
      rightPanelState.context === "group-admin") &&
    tabName !== "gallery"
  ) {
    tabName = "info";
  }
  rightPanelState.tab = tabName;

  $("#rpTabInfo").toggleClass("is-active", tabName === "info");
  $("#rpTabSearch").toggleClass("is-active", tabName === "search");
  $("#rpTabGallery").toggleClass("is-active", tabName === "gallery");
  $("#rpInfoView").toggle(tabName === "info");
  $("#rpSearchView").toggle(tabName === "search");
  $("#rpGalleryView").toggle(tabName === "gallery");

  if (tabName === "search") {
    runRightPanelSearch($("#chatSearchInput").val() || "");
  }
  if (tabName === "gallery") {
    runGallery();
  }
}

function runGallery() {
  var container = $("#rpGalleryGrid");
  var empty = $("#rpGalleryEmpty");
  container.empty();
  empty.hide();

  $.get("/api/messages/images")
    .done(function (images) {
      if (!images || images.length === 0) {
        empty.show();
        return;
      }
      var groups = {};
      images.forEach(function (img) {
        var label = img.chatLabel || "Other";
        if (!groups[label]) groups[label] = [];
        groups[label].push(img);
      });
      var sortedLabels = Object.keys(groups).sort();
      sortedLabels.forEach(function (label) {
        var section = $('<div class="rp-gallery-section"></div>');
        section.append(
          '<div class="rp-gallery-section-title">' +
            $("<span>").text(label).html() +
            " <span class='rp-gallery-section-count'>" +
            groups[label].length +
            "</span></div>",
        );
        var grid = $('<div class="rp-gallery-section-grid"></div>');
        groups[label].forEach(function (img) {
          var item = $('<div class="rp-gallery-item"></div>');
          var imgEl = $("<img>")
            .attr("src", img.content)
            .attr("alt", img.fileName || "Shared image")
            .attr("loading", "lazy")
            .on("click", function () {
              openImageViewer(
                img.content,
                img.senderName,
                img.fileName,
                img.timestamp,
              );
            });
          item.append(imgEl);
          grid.append(item);
        });
        section.append(grid);
        container.append(section);
      });
    })
    .fail(function () {
      empty.find("p").text("Failed to load images.");
      empty.show();
    });
}

function openImageViewer(src, sender, fileName, timestamp) {
  var header = sender || "Unknown";
  if (fileName) header += " - " + fileName;
  if (timestamp) header += " <span class='image-viewer-time'>" + timestamp + "</span>";
  var overlay = $(
    '<div class="image-viewer-overlay"><div class="image-viewer-content"><div class="image-viewer-header"><span>' +
      header +
      '</span><button class="image-viewer-close"><i class="fi fi-rr-cross"></i></button></div><div class="image-viewer-body"><img src="' +
      src +
      '" alt=""/></div></div></div>',
  );
  overlay
    .on("click", function (e) {
      if ($(e.target).hasClass("image-viewer-overlay")) {
        overlay.remove();
      }
    })
    .find(".image-viewer-close")
    .on("click", function () {
      overlay.remove();
    });
  $(document.body).append(overlay);
}

function runRightPanelSearch(queryValue) {
  var query = (queryValue || "").toLowerCase().trim();
  var resultsContainer = $("#searchResultsContainer");
  resultsContainer.empty();

  if (!query) {
    resultsContainer.append(
      '<div class="rp-empty-result"><i class="fi fi-rr-search"></i>Start typing to search in this chat.</div>',
    );
    return;
  }

  var count = 0;
  $("#chatMessages .chat-msg-row").each(function () {
    var msgText = $(this).find(".msg-bubble").text();
    if (!msgText || !msgText.toLowerCase().includes(query)) return;

    var time = $(this).find(".msg-meta").text();
    var sender = $(this).data("sender") || "Unknown";

    var item = $('<div class="search-result-item"></div>');
    item.append("<p><strong>" + sender + ":</strong> " + msgText + "</p>");
    item.append('<span class="search-result-time">' + time + "</span>");

    var rowElement = this;
    item.on("click", function () {
      rowElement.scrollIntoView({ behavior: "smooth", block: "center" });
      $(rowElement).css("background", "rgba(255,255,255,0.1)");
      setTimeout(function () {
        $(rowElement).css("background", "");
      }, 1500);
    });

    resultsContainer.append(item);
    count++;
  });

  if (count === 0) {
    resultsContainer.append(
      '<div class="rp-empty-result"><i class="fi fi-rr-cross-circle"></i>No results found in this conversation.</div>',
    );
  }
}

function applyGroupManageExpandedState() {
  var expanded = !!rightPanelState.manageExpanded;
  $("#rightGroupManageToggle")
    .attr("aria-expanded", expanded ? "true" : "false")
    .toggleClass("is-open", expanded);
  $("#rightGroupAdminActions").toggle(expanded);
}

function renderGroupRightSidebar(g) {
  currentGroupDetail = g;
  var isAdmin = g.myRole === "ADMIN";
  var members = g.members || [];
  rightPanelState.context = isAdmin ? "group-admin" : "group-member";

  $("#rpPanelTitle").text("Group Info");
  $("#rpTabs").hide();
  $("#rpPrivateInfoCard").hide();
  $("#rightGroupPanel").show();
  $("#rpFooter").show();
  $("#rightGroupMembersList").empty();
  $("#rightGroupEditName").val(g.name || "");

  setRightPanelSummary(
    g.name || "Group",
    "Created by @" + (g.createdByUsername || "?"),
    {
      avatarSrc: g.picture || "",
      seed: g.name || "group",
    },
  );

  if (g.createdAt) {
    $("#rightGroupCreated").show();
    $("#rightGroupCreatedText").text("Created " + g.createdAt);
  } else {
    $("#rightGroupCreated").hide();
  }

  $("#rightGroupMemberCount").text("(" + members.length + ")");

  // Keep collapse reset when switching groups
  if (rightPanelState.manageGroupId !== g.id) {
    rightPanelState.manageGroupId = g.id;
    rightPanelState.manageExpanded = false;
  }

  var contactLookup = {};
  (contactsCache || []).forEach(function (c) {
    contactLookup[c.username] = c;
  });

  members.forEach(function (m) {
    var isSelf = m.username === currentUsername;
    var row = $(
      '<li class="group-member-row rp-member-row cr-contact-item"></li>',
    );
    row.attr("role", "button");
    row.attr("tabindex", "0");
    row.attr("aria-label", "Open private chat with @" + m.username);
    row.addClass(isSelf ? "group-member-self" : "group-member-can-chat");
    var contact = contactLookup[m.username];
    var displayName = contact ? contact.fullname || m.username : m.username;
    var avatarSrc = contact ? contact.profilePicture || "" : "";

    var avDiv = $('<div class="gm-avatar cr-contact-avatar"></div>');
    if (avatarSrc) {
      avDiv.addClass("gm-avatar-img");
      avDiv.append('<img src="' + avatarSrc + '" alt=""/>');
    } else {
      avDiv
        .css("background", getAvatarColor(m.username))
        .text(getInitial(displayName));
    }
    row.append(avDiv);

    var infoDiv = $('<div class="gm-info cr-contact-info"></div>');
    var nameDiv = $('<div class="gm-name cr-contact-name"></div>');
    nameDiv.text(displayName);
    infoDiv.append(nameDiv);
    var subText = "@" + m.username;
    if (m.role === "ADMIN") {
      subText += ' <span class="gm-role-badge">admin</span>';
    }
    if (isSelf) {
      subText += ' <span class="gm-self-badge">you</span>';
    }
    infoDiv.append(
      '<div class="gm-sub contact_last_msg">' + subText + "</div>",
    );
    row.append(infoDiv);

    if (!isSelf) {
      var chatIndicator = $(
        '<div class="gm-chat-indicator" title="Start private chat"><i class="fi fi-rr-comment-dots"></i></div>',
      );
      row.append(chatIndicator);


    }

    row.on("click", function () {
      if (isSelf) {
        showToast(
          "This is your account. Pick another member to start a private chat.",
          "info",
        );
        return;
      }
      selectUser(m.username);
      updateRightSidebarInfo();
      $("#messageInput").focus();
    });
    row.on("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        row.trigger("click");
      }
    });

    if (isAdmin && m.username !== currentUsername) {
      var rm = $(
        '<button type="button" class="gm-remove-btn" title="Remove from group"><i class="fi fi-rr-cross"></i></button>',
      );
      rm.on("click", function (e) {
        e.stopPropagation();
        if (!confirm("Remove @" + m.username + " from the group?")) return;
        $.ajax({
          url:
            "/api/groups/" +
            g.id +
            "/members/" +
            encodeURIComponent(m.username),
          method: "DELETE",
          success: function () {
            $.get("/api/groups/" + g.id, renderGroupRightSidebar);
            fetchGroups();
          },
          error: function (xhr) {
            showToast(
              (xhr.responseText || "").substring(0, 200) || "Failed",
              "error",
            );
          },
        });
      });
      row.append(rm);
    }
    $("#rightGroupMembersList").append(row);
  });

  if (isAdmin) {
    $("#rightGroupManageWrap").show();
    var sel = $("#rightGroupAddMemberSelect");
    sel.empty();
    sel.append('<option value="">Choose contact...</option>');
    (contactsCache || []).forEach(function (c) {
      var exists = members.some(function (m) {
        return m.username === c.username;
      });
      if (!exists) {
        sel.append(
          '<option value="' +
            c.username +
            '">' +
            (c.fullname || c.username) +
            " (@" +
            c.username +
            ")</option>",
        );
      }
    });
    applyGroupManageExpandedState();
  } else {
    $("#rightGroupManageWrap").hide();
    $("#rightGroupAdminActions").hide();
  }

  // Group invite button
  $("#rightGroupInviteBtn")
    .off("click")
    .on("click", function () {
      if (!activeGroupId) return;
      $.ajax({
        url: "/api/groups/" + activeGroupId + "/invite",
        method: "POST",
        success: function (data) {
          var link =
            window.location.origin +
            "/invite/" +
            data.token +
            "?group=" +
            activeGroupId;
          copyToClipboard(link);
          showToast(
            "Group invite link copied! Share it with anyone.",
            "success",
          );
        },
        error: function (xhr) {
          showToast(xhr.responseText || "Failed to generate invite", "error");
        },
      });
    });
}

function rightSidebarAddMember() {
  if (!activeGroupId) return;
  var u = $("#rightGroupAddMemberSelect").val();
  if (!u) {
    showToast("Pick a contact", "info");
    return;
  }
  $.ajax({
    url: "/api/groups/" + activeGroupId + "/members",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify({ username: u }),
    success: function () {
      $("#rightGroupAddMemberSelect").val("");
      $.get("/api/groups/" + activeGroupId, renderGroupRightSidebar);
      fetchGroups();
      showToast("Member added", "success");
    },
    error: function (xhr) {
      showToast(
        (xhr.responseText || "").substring(0, 220) || "Failed",
        "error",
      );
    },
  });
}

function rightSidebarLeaveGroup() {
  if (!activeGroupId) return;
  if (!confirm("Leave this group?")) return;
  $.ajax({
    url: "/api/groups/" + activeGroupId + "/leave",
    method: "POST",
    contentType: "application/json",
    success: function () {
      showToast("You left the group", "success");
      $("#right-sidebar").removeClass("open");
      activeGroupId = null;
      fetchGroups();
      selectUser("public");
    },
    error: function (xhr) {
      showToast(
        (xhr.responseText || "").substring(0, 220) || "Failed to leave group",
        "error",
      );
    },
  });
}

function rightSidebarSaveGroupProfile() {
  if (!activeGroupId) return;

  function patch(picture) {
    var nm = $("#rightGroupEditName").val().trim();
    var body = {};
    if (nm) body.name = nm;
    if (picture) body.picture = picture;
    if (!body.name && !body.picture) {
      showToast("Change the group name or pick a new photo to save.", "info");
      return;
    }
    $.ajax({
      url: "/api/groups/" + activeGroupId,
      method: "PATCH",
      contentType: "application/json",
      data: JSON.stringify(body),
      success: function () {
        $("#rightGroupPictureInput").val("");
        $.get("/api/groups/" + activeGroupId, function (gd) {
          renderGroupRightSidebar(gd);
          selectGroupChat(activeGroupId);
          fetchGroups();
        });
        showToast("Group updated", "success");
      },
      error: function (xhr) {
        showToast(
          (xhr.responseText || "").substring(0, 220) || "Failed",
          "error",
        );
      },
    });
  }

  var file =
    $("#rightGroupPictureInput")[0].files &&
    $("#rightGroupPictureInput")[0].files[0];
  if (file) {
    if (file.size > 5 * 1024 * 1024) {
      showToast("Photo must be under 5MB", "error");
      return;
    }
    var fr = new FileReader();
    fr.onload = function () {
      patch(fr.result);
    };
    fr.readAsDataURL(file);
  } else {
    patch(null);
  }
}

function updateRightSidebarInfo() {
  $("#chatSearchInput").val("");
  $("#searchResultsContainer").empty();
  rightPanelState.manageExpanded = false;
  rightPanelState.manageGroupId = null;
  $("#rightGroupPanel").hide();
  $("#rightGroupManageWrap").hide();
  $("#rightGroupAdminActions").hide();
  $("#rpFooter").hide();

  // Clean up dynamically added rows from previous session
  $(
    "#rpUserBioRow, #rpBlockRow, #rp-shared-groups-section, #rp-delete-conv-section",
  ).remove();

  if (activeGroupId != null) {
    rightPanelState.context = "group-member";
    setRightPanelTab("info");
    $.get("/api/groups/" + activeGroupId, renderGroupRightSidebar);
    return;
  }

  $("#rpTabs").show();
  $("#rpPrivateInfoCard").show();
  $("#rpPanelTitle").text("Contact Info");

  if (selectedUser === "public") {
    rightPanelState.context = "public";
    $("#rpPrivateInfoCard").addClass("rp-public-info-card");
    setRightPanelSummary("Public Chat Room", "Chatting with everyone", {
      iconHtml: '<i class="fi fi-sr-comment-dots"></i>',
      iconBg: "linear-gradient(135deg,#2563eb,#7c3aed)",
    });
    setRightPanelInfoCard(
      "Public channel",
      "Everyone can see this conversation",
    );
  } else if (selectedUser && selectedUser !== "__none__") {
    rightPanelState.context = "private";
    $("#rpPrivateInfoCard").removeClass("rp-public-info-card");
    var contactItem = $("#contact-item-" + selectedUser);
    var fullname = contactItem.data("fullname") || selectedUser;
    var avatarSrc = contactItem.data("avatar");

    setRightPanelSummary(fullname, "@" + selectedUser, {
      avatarSrc: avatarSrc || "",
      seed: selectedUser,
    });
    setRightPanelInfoCard(
      "Private chat",
      "Direct messages with @" + selectedUser,
    );

    // Fetch user info for bio and block status
    $.get("/api/users/" + selectedUser, function (info) {
      var bioEl = $("#rpUserBio");
      if (info.bio) {
        if (bioEl.length === 0) {
          $("#rpPrivateInfoCard").append(
            '<div class="rp-field-row" id="rpUserBioRow">' +
              '<span class="rp-field-label">Bio</span>' +
              '<span class="rp-field-value" id="rpUserBio">' +
              escapeHtml(info.bio) +
              "</span>" +
              "</div>",
          );
        } else {
          bioEl.text(info.bio);
        }
      }

      var blockBtn = $("#rpBlockBtn");
      var blocked = info.blocked;
      if (blockBtn.length === 0) {
        var actionHtml =
          '<div class="rp-field-row" id="rpBlockRow" style="border-bottom:none;padding-top:4px;">';
        actionHtml +=
          '<button class="tooltip-btn ' +
          (blocked ? "tooltip-btn-unblock" : "tooltip-btn-block") +
          '" id="rpBlockBtn" style="flex:1;display:flex;align-items:center;justify-content:center;gap:5px;padding:7px;border-radius:var(--radius-sm);font-size:11px;font-weight:600;cursor:pointer;border:none;transition:var(--transition-fast);font-family:var(--font-body);">';
        actionHtml += blocked
          ? '<i class="fi fi-rr-check"></i> Unblock'
          : '<i class="fi fi-rr-ban"></i> Block';
        actionHtml += "</button></div>";
        $("#rpPrivateInfoCard").append(actionHtml);
        $("#rpBlockBtn").on("click", function () {
          var blockedNow = $(this).text().trim() === "Unblock";
          if (blockedNow) {
            unblockUser(selectedUser);
            $(this)
              .html('<i class="fi fi-rr-ban"></i> Block')
              .removeClass("tooltip-btn-unblock")
              .addClass("tooltip-btn-block");
          } else {
            blockUser(selectedUser);
            $(this)
              .html('<i class="fi fi-rr-check"></i> Unblock')
              .removeClass("tooltip-btn-block")
              .addClass("tooltip-btn-unblock");
          }
        });
      } else {
        blockBtn
          .html(
            blocked
              ? '<i class="fi fi-rr-check"></i> Unblock'
              : '<i class="fi fi-rr-ban"></i> Block',
          )
          .removeClass("tooltip-btn-block tooltip-btn-unblock")
          .addClass(blocked ? "tooltip-btn-unblock" : "tooltip-btn-block");
      }
    });

    // Load shared groups
    loadSharedGroups(selectedUser);

    // Re-render delete conversation section for the current contact
    $("#rp-delete-conv-section").remove();
    renderDeleteConversationSection(selectedUser);
  } else {
    rightPanelState.context = "public";
  }

  setRightPanelTab(rightPanelState.tab);
}

/* ==============================================
   SHARED GROUPS + DELETE CONVERSATION (right panel)
   ============================================== */

/**
 * Fetches groups shared between the current user and targetUsername,
 * then renders them in the right panel info view.
 */
function loadSharedGroups(targetUsername) {
  // Remove any previous shared-groups section
  $("#rp-shared-groups-section").remove();

  $.get(
    "/api/users/" + encodeURIComponent(targetUsername) + "/shared-groups",
    function (groups) {
      var $infoView = $("#rpInfoView");
      if (!$infoView.length) return;

      var section = document.createElement("div");
      section.id = "rp-shared-groups-section";
      section.className = "rp-shared-groups";

      var header = document.createElement("div");
      header.className = "rp-section-header";
      header.innerHTML =
        '<i class="fi fi-sr-users"></i>' +
        "<span>Groups in Common</span>" +
        '<span class="rp-section-count">' +
        groups.length +
        "</span>";
      section.appendChild(header);

      if (groups.length === 0) {
        var empty = document.createElement("div");
        empty.className = "rp-shared-groups-empty";
        empty.innerHTML =
          '<i class="fi fi-rr-users-alt"></i><span>No groups in common</span>';
        section.appendChild(empty);
      } else {
        var list = document.createElement("div");
        list.className = "rp-shared-groups-list";
        groups.forEach(function (g) {
          var item = document.createElement("div");
          item.className = "rp-shared-group-item";

          // Avatar
          var avatarDiv = document.createElement("div");
          avatarDiv.className = "rp-shared-group-avatar";
          if (g.photo) {
            var img = document.createElement("img");
            img.src = g.photo;
            img.alt = "";
            avatarDiv.appendChild(img);
          } else {
            avatarDiv.style.background = getAvatarColor(g.name);
            avatarDiv.textContent = getInitial(g.name);
          }

          // Info
          var infoDiv = document.createElement("div");
          infoDiv.className = "rp-shared-group-info";

          var nameEl = document.createElement("div");
          nameEl.className = "rp-shared-group-name";
          nameEl.textContent = g.name;

          var metaEl = document.createElement("div");
          metaEl.className = "rp-shared-group-meta";
          metaEl.textContent =
            g.members + " member" + (g.members !== 1 ? "s" : "");

          infoDiv.appendChild(nameEl);
          infoDiv.appendChild(metaEl);

          // Click → open that group
          item.addEventListener("click", function () {
            selectGroupChat(g.id);
            // Close right sidebar on mobile
            if (window.innerWidth <= 768) {
              $("#right-sidebar").removeClass("open");
              $("#right-sidebar-backdrop").hide();
            }
          });

          item.appendChild(avatarDiv);
          item.appendChild(infoDiv);
          list.appendChild(item);
        });
        section.appendChild(list);
      }

      // Insert into info view (before delete section if it exists, otherwise at end)
      var deleteSection = document.getElementById("rp-delete-conv-section");
      if (deleteSection) {
        $infoView[0].insertBefore(section, deleteSection);
      } else {
        $infoView.append(section);
      }
    },
  );
}

/**
 * Renders the "Delete Conversation" danger zone in the right panel.
 * Shows a button that opens an inline password-confirmation form.
 */
function renderDeleteConversationSection(targetUsername) {
  var $infoView = $("#rpInfoView");
  if (!$infoView.length) return;

  var section = document.createElement("div");
  section.id = "rp-delete-conv-section";
  section.className = "rp-danger-zone";

  section.innerHTML =
    '<div class="rp-danger-header">' +
    '<i class="fi fi-sr-trash"></i>' +
    "<span>Danger Zone</span>" +
    "</div>" +
    '<button class="rp-delete-conv-btn" id="rp-delete-conv-trigger">' +
    '<i class="fi fi-sr-trash"></i> Delete All Messages' +
    "</button>" +
    // Inline confirmation form (hidden by default)
    '<div class="rp-delete-conv-confirm" id="rp-delete-conv-confirm" style="display:none;">' +
    '<p class="rp-delete-conv-warning">' +
    '<i class="fi fi-sr-exclamation"></i> ' +
    "This will permanently delete <strong>all messages</strong> with <strong>" +
    escapeHtml(targetUsername) +
    "</strong>. This cannot be undone." +
    "</p>" +
    '<div class="rp-delete-conv-pw-wrap">' +
    '<input type="password" id="rp-delete-conv-pw" class="rp-delete-conv-pw-input" ' +
    'placeholder="Enter your password to confirm" autocomplete="current-password" ' +
    'style="font-size:max(16px,13px);"/>' +
    "</div>" +
    '<div class="rp-delete-conv-actions">' +
    '<button class="rp-delete-conv-cancel" id="rp-delete-conv-cancel">Cancel</button>' +
    '<button class="rp-delete-conv-submit" id="rp-delete-conv-submit">' +
    '<i class="fi fi-sr-trash"></i> Confirm Delete' +
    "</button>" +
    "</div>" +
    '<div class="rp-delete-conv-feedback" id="rp-delete-conv-feedback"></div>' +
    "</div>";

  $infoView.append(section);

  // Toggle confirmation form
  document
    .getElementById("rp-delete-conv-trigger")
    .addEventListener("click", function () {
      var confirm = document.getElementById("rp-delete-conv-confirm");
      var isOpen = confirm.style.display !== "none";
      confirm.style.display = isOpen ? "none" : "block";
      if (!isOpen) {
        document.getElementById("rp-delete-conv-pw").value = "";
        document.getElementById("rp-delete-conv-feedback").textContent = "";
        setTimeout(function () {
          document.getElementById("rp-delete-conv-pw").focus();
        }, 80);
      }
    });

  // Cancel
  document
    .getElementById("rp-delete-conv-cancel")
    .addEventListener("click", function () {
      document.getElementById("rp-delete-conv-confirm").style.display = "none";
      document.getElementById("rp-delete-conv-pw").value = "";
      document.getElementById("rp-delete-conv-feedback").textContent = "";
    });

  // Allow Enter key in password field
  document
    .getElementById("rp-delete-conv-pw")
    .addEventListener("keydown", function (e) {
      if (e.key === "Enter")
        document.getElementById("rp-delete-conv-submit").click();
    });

  // Submit
  document
    .getElementById("rp-delete-conv-submit")
    .addEventListener("click", function () {
      var pw = document.getElementById("rp-delete-conv-pw").value;
      var feedback = document.getElementById("rp-delete-conv-feedback");
      var btn = document.getElementById("rp-delete-conv-submit");

      if (!pw) {
        setDeleteConvFeedback("error", "Please enter your password.");
        return;
      }

      btn.disabled = true;
      btn.innerHTML =
        '<i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i> Deleting…';

      $.ajax({
        url: "/api/conversations/" + encodeURIComponent(targetUsername),
        method: "DELETE",
        contentType: "application/json",
        data: JSON.stringify({ password: pw }),
        success: function (res) {
          var count = res.deleted || 0;
          setDeleteConvFeedback(
            "success",
            count === 0
              ? "No messages to delete."
              : count + " message" + (count !== 1 ? "s" : "") + " deleted.",
          );

          // Clear the chat panel if we're currently viewing this conversation
          if (selectedUser === targetUsername) {
            $("#chatMessages").empty();
          }

          // Reset form after short delay
          setTimeout(function () {
            document.getElementById("rp-delete-conv-confirm").style.display =
              "none";
            document.getElementById("rp-delete-conv-pw").value = "";
            document.getElementById("rp-delete-conv-feedback").textContent = "";
            btn.disabled = false;
            btn.innerHTML = '<i class="fi fi-sr-trash"></i> Confirm Delete';
          }, 2200);
        },
        error: function (xhr) {
          var msg =
            xhr.responseJSON && xhr.responseJSON.error
              ? xhr.responseJSON.error
              : xhr.responseText || "Failed to delete messages.";
          setDeleteConvFeedback("error", msg);
          btn.disabled = false;
          btn.innerHTML = '<i class="fi fi-sr-trash"></i> Confirm Delete';
        },
      });
    });
}

function setDeleteConvFeedback(type, message) {
  var el = document.getElementById("rp-delete-conv-feedback");
  if (!el) return;
  el.className = "rp-delete-conv-feedback rp-delete-conv-feedback--" + type;
  el.textContent = message;
}

/* ==============================================
   GLOBAL SEARCH (sidebar)
   ============================================== */
var globalSearchDebounce = null;

$(document).ready(function () {
  var $input = $("#contactSearch");
  var $panel = $("#sidebarGlobalSearchPanel");
  var $scroll = $(".sidebar-contacts-scroll");
  var $labels = $(".sidebar-contacts-label");
  var $clear = $("#sidebarSearchClear");

  $input.on("input", function () {
    var q = $(this).val().trim();
    $clear.toggle(q.length > 0);

    clearTimeout(globalSearchDebounce);

    if (!q) {
      closeGlobalSearch();
      return;
    }

    globalSearchDebounce = setTimeout(function () {
      runGlobalSearch(q);
    }, 220);
  });

  $clear.on("click", function () {
    $input.val("").trigger("input").focus();
  });

  // Close search when clicking outside
  $(document).on("click.globalsearch", function (e) {
    if (
      !$(e.target).closest(".sidebar-search-bar, #sidebarGlobalSearchPanel")
        .length
    ) {
      closeGlobalSearch();
      $input.val("").trigger("input");
      $clear.hide();
    }
  });
});

function closeGlobalSearch() {
  $("#sidebarGlobalSearchPanel").hide();
  $(".sidebar-contacts-scroll").show();
  $(".sidebar-contacts-label").show();
}

function runGlobalSearch(q) {
  var $panel = $("#sidebarGlobalSearchPanel");
  var $scroll = $(".sidebar-contacts-scroll");
  var $labels = $(".sidebar-contacts-label");
  var $contactsList = $("#sgspContactsList");
  var $msgsList = $("#sgspMessagesList");
  var $empty = $("#sgspEmpty");
  var $cLabel = $("#sgspContactsLabel");
  var $mLabel = $("#sgspMessagesLabel");

  $scroll.hide();
  $labels.hide();
  $panel.show();
  $contactsList.empty();
  $msgsList.empty();
  $empty.hide();
  $cLabel.show();
  $mLabel.hide();

  var ql = q.toLowerCase();

  // ---- 1. Contacts (local, instant) ----
  var allContacts = [];

  // Public chat always first
  if ("public chat room".includes(ql) || "public".includes(ql)) {
    allContacts.push({ type: "public" });
  }

  // Real contacts from cache
  (contactsCache || []).forEach(function (c) {
    var hay = ((c.fullname || "") + " " + c.username).toLowerCase();
    if (hay.includes(ql)) {
      allContacts.push({ type: "contact", data: c });
    }
  });

  // Groups
  $("#groupChatList .cr-contact-item").each(function () {
    var name = $(this).find(".cr-contact-name").text().toLowerCase();
    if (name.includes(ql)) {
      var gid = $(this).data("group-id");
      var gname = $(this).find(".cr-contact-name").text();
      allContacts.push({ type: "group", id: gid, name: gname });
    }
  });

  if (allContacts.length === 0) {
    $cLabel.hide();
  } else {
    allContacts.forEach(function (item) {
      var row;
      if (item.type === "public") {
        row = buildContactSearchRow(
          "linear-gradient(135deg,#2563eb,#7c3aed)",
          '<i class="fi fi-sr-comment-dots" style="font-size:15px;color:#fff;"></i>',
          "Public Chat Room",
          "Everyone",
          null,
            function () {
             selectUser("public");
             closeGlobalSearch();
             $("#contactSearch").val("").trigger("input");
             $("#sidebarSearchClear").hide();
           },
         );
       } else if (item.type === "contact") {
         var c = item.data;
         var display = c.fullname || c.username;
         row = buildContactSearchRow(
           getAvatarColor(c.username),
           c.profilePicture ? null : getInitial(display),
           display,
           "@" + c.username,
           c.profilePicture || null,
           function () {
             selectUser(c.username);
             closeGlobalSearch();
             $("#contactSearch").val("").trigger("input");
             $("#sidebarSearchClear").hide();
           },
         );
       } else {
         row = buildContactSearchRow(
           getAvatarColor(item.name),
           getInitial(item.name),
           item.name,
           "Group",
           null,
           function () {
             selectGroupChat(item.id);
             closeGlobalSearch();
             $("#contactSearch").val("").trigger("input");
             $("#sidebarSearchClear").hide();
           },
         );
      }
      $contactsList.append(row);
    });
  }

  // ---- 2. Messages — backend search across ALL chats ----
  if (q.length < 2) {
    if (allContacts.length === 0) $empty.show();
    return;
  }

  // Show a loading indicator while waiting
  $mLabel.show().text("Messages");
  $msgsList.html(
    '<div class="sgsp-empty" style="padding:12px 16px;"><i class="fi fi-rr-spinner" style="font-size:16px;opacity:0.4;"></i> Searching…</div>',
  );

  $.get("/api/messages/search", { q: q }, function (results) {
    $msgsList.empty();

    if (!results || results.length === 0) {
      $mLabel.hide();
      if (allContacts.length === 0) $empty.show();
      return;
    }

    $mLabel.show().text("Messages (" + results.length + ")");

    results.forEach(function (item) {
      var re = new RegExp("(" + escapeRegex(q) + ")", "gi");
      var highlighted = escapeHtml(item.content).replace(re, "<mark>$1</mark>");

      var row = $('<div class="sgsp-msg-row"></div>');
      row.append(
        '<div class="sgsp-msg-chat">' + escapeHtml(item.chatLabel) + "</div>",
      );
      row.append('<div class="sgsp-msg-text">' + highlighted + "</div>");
      row.append(
        '<div class="sgsp-msg-meta">' +
          escapeHtml(item.senderName) +
          " · " +
          escapeHtml(item.timestamp) +
          "</div>",
      );

      row.on("click", function () {
        closeGlobalSearch();
        $("#contactSearch").val("").trigger("input");
        $("#sidebarSearchClear").hide();

        // Navigate to the correct chat, then scroll to message
        function jumpToMsg() {
          var el = document.getElementById("msg-" + item.id);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            $(el).addClass("msg-pinned-highlight");
            setTimeout(function () {
              $(el).removeClass("msg-pinned-highlight");
            }, 1600);
          }
        }

        if (item.chatType === "public") {
          selectUser("public");
          setTimeout(jumpToMsg, 400);
        } else if (item.chatType === "group") {
          selectGroupChat(item.chatId);
          setTimeout(jumpToMsg, 400);
        } else {
          selectUser(item.chatId);
          setTimeout(jumpToMsg, 400);
        }
      });

      $msgsList.append(row);
    });
  }).fail(function () {
    $msgsList.html('<div class="sgsp-empty">Search failed. Try again.</div>');
  });
}

function buildContactSearchRow(bgColor, initial, name, sub, imgSrc, onClick) {
  var row = $('<div class="sgsp-contact-row"></div>');
  var av = $('<div class="sgsp-contact-avatar"></div>');

  if (imgSrc) {
    av.append('<img src="' + imgSrc + '" alt=""/>');
  } else if (initial && initial.startsWith("<")) {
    av.css("background", bgColor).html(initial);
  } else {
    av.css("background", bgColor).text(initial || "?");
  }

  var info = $('<div style="flex:1;min-width:0;"></div>');
  info.append('<div class="sgsp-contact-name">' + escapeHtml(name) + "</div>");
  info.append('<div class="sgsp-contact-sub">' + escapeHtml(sub) + "</div>");

  row.append(av).append(info);
  row.on("click", onClick);
  return row;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ==============================================
   PIN MESSAGE  (server-backed, per chat)
   ============================================== */
var currentPinnedMsg = null;

function getPinnedChatKey() {
  if (activeGroupId != null) return "pin_group_" + activeGroupId;
  return "pin_user_" + selectedUser;
}

function pinMessage(msgId) {
  // Toggle: if same message is already pinned → unpin
  if (currentPinnedMsg && currentPinnedMsg.id == msgId) {
    unpinMessageById(msgId);
    return;
  }

  $.ajax({
    url: "/api/messages/" + msgId + "/pin",
    method: "POST",
    success: function () {
      showToast("Message pinned", "success");
      loadPinnedBarForCurrentChat();
    },
    error: function (xhr) {
      var msg = "Failed to pin message";
      if (xhr.responseJSON && xhr.responseJSON.error) msg += ": " + xhr.responseJSON.error;
      showToast(msg, "error");
    },
  });
}

function unpinMessageById(msgId) {
  $.ajax({
    url: "/api/messages/" + msgId + "/unpin",
    method: "POST",
    success: function () {
      currentPinnedMsg = null;
      renderPinnedBar(null);
      showToast("Message unpinned", "info");
    },
    error: function (xhr) {
      var msg = "Failed to unpin message";
      if (xhr.responseJSON && xhr.responseJSON.error) msg += ": " + xhr.responseJSON.error;
      showToast(msg, "error");
    },
  });
}

function renderPinnedBar(pinObj) {
  var $bar = $("#pinnedMsgBar");
  if (!pinObj) {
    $bar.hide();
    return;
  }
  var preview =
    pinObj.content.length > 60 ? pinObj.content.substring(0, 60) + "…" : pinObj.content;
  $("#pinnedMsgPreview").text(preview);
  $bar.show();
}

function loadPinnedBarForCurrentChat() {
  var type = activeGroupId != null ? "group" : selectedUser === "public" ? "public" : "user";
  var id = activeGroupId != null ? activeGroupId : selectedUser;

  if (!id) {
    currentPinnedMsg = null;
    renderPinnedBar(null);
    return;
  }

  $.ajax({
    url: "/api/messages/pinned?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(id),
    method: "GET",
    success: function (data) {
      if (data && data.pinned) {
        currentPinnedMsg = data;
        renderPinnedBar(data);
      } else {
        currentPinnedMsg = null;
        renderPinnedBar(null);
      }
    },
    error: function () {
      currentPinnedMsg = null;
      renderPinnedBar(null);
    },
  });
}

// Jump to pinned message
$(document).ready(function () {
  $("#pinnedMsgJump").on("click", function () {
    if (!currentPinnedMsg) return;
    var el = document.getElementById("msg-" + currentPinnedMsg.id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      $(el).addClass("msg-pinned-highlight");
      setTimeout(function () {
        $(el).removeClass("msg-pinned-highlight");
      }, 1600);
    } else {
      showToast("Message not visible in current view", "info");
    }
  });

  $("#pinnedMsgUnpin").on("click", function () {
    if (!currentPinnedMsg) return;
    unpinMessageById(currentPinnedMsg.id);
  });
});

// selectUser and selectGroupChat already call loadPinnedBarForCurrentChat directly.

/* ==============================================
   FORWARD MESSAGE
   ============================================== */
var forwardMessageId = null;
var forwardMessageText = null;
var forwardSelected = {}; // { 'user:alice': true, 'group:5': true }

function openForwardModal(msgId, text) {
  forwardMessageId = msgId;
  forwardMessageText = text;
  forwardSelected = {};

  // Preview
  var preview = text.length > 80 ? text.substring(0, 80) + "…" : text;
  $("#forwardMsgPreview").text(preview);

  // Build list
  buildForwardList("");

  $("#forwardSearchInput").val("");
  $("#confirmForwardBtn").prop("disabled", true);
  $("#forwardModal").show();
  $("#forwardSearchInput").focus();
}

function buildForwardList(q) {
  var $list = $("#forwardList");
  $list.empty();
  var ql = (q || "").toLowerCase();

  // Public chat
  if (!ql || "public chat room".includes(ql)) {
    $list.append(
      buildForwardItem(
        "user",
        "public",
        "Public Chat Room",
        "Everyone",
        null,
        "linear-gradient(135deg,#2563eb,#7c3aed)",
        null,
        true,
      ),
    );
  }

  // Contacts
  (contactsCache || []).forEach(function (c) {
    var display = c.fullname || c.username;
    if (
      ql &&
      !(
        display.toLowerCase().includes(ql) ||
        c.username.toLowerCase().includes(ql)
      )
    )
      return;
    $list.append(
      buildForwardItem(
        "user",
        c.username,
        display,
        "@" + c.username,
        c.profilePicture || null,
        getAvatarColor(c.username),
        getInitial(display),
        false,
      ),
    );
  });

  // Groups
  $("#groupChatList .cr-contact-item").each(function () {
    var gid = $(this).data("group-id");
    var gname = $(this).find(".cr-contact-name").text();
    var gpic = $(this).find("img").attr("src") || null;
    if (ql && !gname.toLowerCase().includes(ql)) return;
    $list.append(
      buildForwardItem(
        "group",
        gid,
        gname,
        "Group",
        gpic,
        getAvatarColor(gname),
        getInitial(gname),
        false,
      ),
    );
  });
}

function buildForwardItem(
  type,
  id,
  name,
  sub,
  imgSrc,
  bgColor,
  initial,
  isPublic,
) {
  var key = type + ":" + id;
  var item = $('<div class="forward-item" data-key="' + key + '"></div>');

  var av = $(
    '<div class="forward-item-avatar' +
      (type === "group" ? " group-avatar" : "") +
      '"></div>',
  );
  if (imgSrc) {
    av.append('<img src="' + imgSrc + '" alt=""/>');
  } else if (isPublic) {
    av.css("background", bgColor).html(
      '<i class="fi fi-sr-comment-dots" style="font-size:15px;color:#fff;"></i>',
    );
  } else {
    av.css("background", bgColor).text(initial || "?");
  }

  var info = $('<div class="forward-item-info"></div>');
  info.append('<div class="forward-item-name">' + escapeHtml(name) + "</div>");
  info.append('<div class="forward-item-sub">' + escapeHtml(sub) + "</div>");

  var tick = $(
    '<div class="forward-item-tick"><i class="fi fi-br-check"></i></div>',
  );

  item.append(av).append(info).append(tick);

  item.on("click", function () {
    if (forwardSelected[key]) {
      delete forwardSelected[key];
      item.removeClass("selected");
    } else {
      forwardSelected[key] = { type: type, id: id, name: name };
      item.addClass("selected");
    }
    var count = Object.keys(forwardSelected).length;
    $("#confirmForwardBtn").prop("disabled", count === 0);
    if (count > 0) {
      $("#confirmForwardBtn").html(
        '<i class="fi fi-rr-share"></i> Forward (' + count + ")",
      );
    } else {
      $("#confirmForwardBtn").html('<i class="fi fi-rr-share"></i> Forward');
    }
  });

  return item;
}

$(document).ready(function () {
  $("#forwardSearchInput").on("input", function () {
    buildForwardList($(this).val().trim());
    // Re-apply selected state
    Object.keys(forwardSelected).forEach(function (key) {
      $('[data-key="' + key + '"]').addClass("selected");
    });
  });

  $("#closeForwardModal, #cancelForwardBtn").on("click", function () {
    $("#forwardModal").hide();
    forwardMessageId = null;
    forwardMessageText = null;
    forwardSelected = {};
  });

  $("#confirmForwardBtn").on("click", function () {
    if (!forwardMessageId) return;
    var targets = Object.values(forwardSelected);
    if (targets.length === 0) return;

    $.ajax({
      url: "/api/messages/forward",
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({
        messageId: forwardMessageId,
        targets: targets.map(function (t) {
          return { type: t.type, id: t.type === "group" ? Number(t.id) : t.id };
        }),
      }),
      success: function () {
        $("#forwardModal").hide();
        forwardMessageId = null;
        forwardMessageText = null;
        forwardSelected = {};
        showToast(
          "Message forwarded to " +
            targets.length +
            " chat" +
            (targets.length > 1 ? "s" : ""),
          "success",
        );
      },
      error: function (xhr) {
        var msg = "Failed to forward message";
        if (xhr.responseJSON && xhr.responseJSON.error) {
          msg += ": " + xhr.responseJSON.error;
        }
        showToast(msg, "error");
      },
    });
  });
});

/* ==============================================
   EMOJI AUTOCOMPLETE — :shortcode in input
   ============================================== */
var EMOJI_MAP = {
  "smile": "😊", "smiley": "😃", "grinning": "😀", "grin": "😁",
  "joy": "😂", "laughing": "😆", "sweat_smile": "😅", "rofl": "🤣",
  "wink": "😉", "blush": "😳", "innocent": "😇", "heart_eyes": "😍",
  "kissing_heart": "😘", "kissing": "😗", "kissing_smiling_eyes": "😙",
  "kissing_closed_eyes": "😚", "yum": "😋", "stuck_out_tongue": "😛",
  "stuck_out_tongue_winking_eye": "😜", "stuck_out_tongue_closed_eyes": "😝",
  "neutral_face": "😐", "expressionless": "😑", "no_mouth": "😶",
  "smirk": "😏", "unamused": "😒", "pensive": "😔", "worried": "😟",
  "confused": "😕", "persevere": "😣", "disappointed": "😞",
  "disappointed_relieved": "😥", "frowning": "😦", "anguished": "😧",
  "fearful": "😨", "weary": "😩", "sob": "😭", "cry": "😢",
  "triumph": "😤", "angry": "😠", "rage": "😡", "sleepy": "😪",
  "sleeping": "😴", "mask": "😷", "sunglasses": "😎", "dizzy_face": "😵",
  "astonished": "😲", "flushed": "😳", "hot": "🥵", "cold": "🥶",
  "scream": "😱", "hugging": "🤗", "thinking": "🤔", "hand_over_mouth": "🤭",
  "shushing": "🤫", "zipper_mouth": "🤐", "raised_eyebrow": "🤨",
  "nerd": "🤓", "monocle": "🧐", "star_struck": "🤩",
  "party": "🥳", "pleading": "🥺", "yawn": "🥱", "sneeze": "🤧",
  "vomiting": "🤮", "cowboy": "🤠", "clown": "🤡", "lying": "🤥",
  "slight_smile": "🙂", "slight_frown": "🙁", "upside_down": "🙃",
  "rolling_eyes": "🙄", "facepalm": "🤦", "shrug": "🤷",
  "wave": "👋", "raised_hand": "✋", "ok_hand": "👌", "pinch": "🤏",
  "crossed_fingers": "🤞", "peace": "✌️", "love_you": "🤟",
  "thumbsup": "👍", "thumbsdown": "👎", "clap": "👏", "open_hands": "👐",
  "raised_hands": "🙌", "folded_hands": "🙏", "muscle": "💪",
  "fire": "🔥", "100": "💯", "party_popper": "🎉", "balloon": "🎈",
  "gift": "🎁", "tada": "🎉", "confetti": "🎊", "sparkles": "✨",
  "star": "⭐", "glowing_star": "🌟", "dizzy": "💫", "boom": "💥",
  "collision": "💥", "heart": "❤️", "heartbeat": "💓", "heartpulse": "💗",
  "pink_heart": "🩷", "orange_heart": "🧡", "yellow_heart": "💛",
  "green_heart": "💚", "blue_heart": "💙", "purple_heart": "💜",
  "black_heart": "🖤", "broken_heart": "💔", "two_hearts": "💕",
  "sparkling_heart": "💖", "revolving_hearts": "💞", "cupid": "💘",
  "kiss": "💋", "eyes": "👀", "eye": "👁️", "see_no_evil": "🙈",
  "hear_no_evil": "🙉", "speak_no_evil": "🙊",
  "footprints": "👣", "lips": "👄", "tongue": "👅", "ear": "👂",
  "nose": "👃", "brain": "🧠", "eye_speech_bubble": "💬",
  "speech_balloon": "💬", "thought_balloon": "💭", "zzz": "💤",
  "poop": "💩", "skull": "💀", "alien": "👽", "robot": "🤖",
  "ghost": "👻", "jack_o_lantern": "🎃", "santa": "🎅",
  "clinking_glasses": "🥂", "wine_glass": "🍷", "beer": "🍺",
  "beers": "🍻", "cocktail": "🍸", "tropical_drink": "🍹",
  "coffee": "☕", "tea": "🍵", "wine": "🍷", "cake": "🎂",
  "birthday": "🎂", "pizza": "🍕", "hamburger": "🍔", "fries": "🍟",
  "hotdog": "🌭", "taco": "🌮", "burrito": "🌯", "donut": "🍩",
  "cookie": "🍪", "popcorn": "🍿", "icecream": "🍦",
  "chocolate": "🍫", "candy": "🍬", "apple": "🍎", "banana": "🍌",
  "grapes": "🍇", "watermelon": "🍉", "strawberry": "🍓",
  "sun": "☀️", "moon": "🌙", "rainbow": "🌈", "cloud": "☁️",
  "lightning": "⚡", "thunder": "🌩️", "snowflake": "❄️",
  "umbrella": "☂️", "dog": "🐶", "cat": "🐱", "mouse": "🐭",
  "rabbit": "🐰", "fox": "🦊", "bear": "🐻", "panda": "🐼",
  "koala": "🐨", "tiger": "🐯", "lion": "🦁", "cow": "🐮",
  "pig": "🐷", "frog": "🐸", "monkey": "🐵", "chicken": "🐔",
  "bird": "🐦", "snake": "🐍", "dragon": "🐉", "unicorn": "🦄",
  "bee": "🐝", "butterfly": "🦋", "bug": "🐛", "ant": "🐜",
  "snail": "🐌", "turtle": "🐢", "fish": "🐟", "dolphin": "🐬",
  "whale": "🐳", "octopus": "🐙", "crab": "🦀", "shark": "🦈",
  "rose": "🌹", "flower": "🌸", "sunflower": "🌻", "blossom": "🌼",
  "cherry_blossom": "🌸", "tulip": "🌷", "seedling": "🌱",
  "palm_tree": "🌴", "cactus": "🌵", "mushroom": "🍄",
  "earth": "🌍", "globe": "🌏", "rocket": "🚀", "satellite": "🛰️",
  "airplane": "✈️", "car": "🚗", "bus": "🚌", "train": "🚆",
  "bicycle": "🚲", "motorcycle": "🏍️", "anchor": "⚓",
  "ship": "🚢", "watch": "⌚", "mobile": "📱", "computer": "💻",
  "keyboard": "⌨️", "lock": "🔒", "unlock": "🔓", "key": "🔑",
  "bulb": "💡", "flashlight": "🔦", "book": "📖", "pencil": "✏️",
  "scissors": "✂️", "paperclip": "📎", "calendar": "📅",
  "alarm": "⏰", "stopwatch": "⏱️", "musical_note": "🎵",
  "notes": "🎶", "microphone": "🎤", "headphone": "🎧",
  "radio": "📻", "guitar": "🎸", "trumpet": "🎺", "violin": "🎻",
  "drum": "🥁", "game": "🎮", "dice": "🎲", "spade": "♠️",
  "heart_suit": "♥️", "diamond_suit": "♦️", "club": "♣️",
  "checkered_flag": "🏁", "trophy": "🏆", "medal": "🏅",
  "crown": "👑", "gem": "💎", "ring": "💍", "clapper": "🎬",
  "art": "🎨", "palette": "🎨", "camera": "📷", "video": "📹",
  "tv": "📺", "cd": "💿", "dvd": "📀", "inbox": "📥",
  "outbox": "📤", "email": "✉️", "envelope": "✉️", "mailbox": "📫",
  "postbox": "📮", "telephone": "☎️", "chart": "📊", "bar_chart": "📊",
  "money": "💰", "credit_card": "💳", "dollar": "💵", "euro": "💶",
  "pound": "💷", "yen": "💴", "shopping": "🛍️", "receipt": "🧾",
  "wrench": "🔧", "hammer": "🔨", "screwdriver": "🪛", "nut_bolt": "🔩",
  "link": "🔗", "magnifying_glass": "🔍", "lock_with_pen": "🔏",
  "syringe": "💉", "pill": "💊", "stethoscope": "🩺",
  "basketball": "🏀", "football": "⚽", "baseball": "⚾",
  "tennis": "🎾", "golf": "⛳", "swimming": "🏊", "surfing": "🏄",
  "snowboarder": "🏂", "skier": "⛷️", "running": "🏃", "walking": "🚶",
  "horse_racing": "🏇", "weight_lifter": "🏋️",
  "pin": "📌", "pushpin": "📌", "round_pushpin": "📍",
  "triangular_flag": "🚩", "red_circle": "🔴", "blue_circle": "🔵",
  "white_circle": "⚪", "black_circle": "⚫", "red_square": "🟥",
  "blue_square": "🟦", "orange_square": "🟧", "green_square": "🟩",
  "purple_square": "🟪", "brown_square": "🟫", "black_square": "⬛",
  "white_square": "⬜", "check": "✅", "cross_mark": "❌",
  "exclamation": "❗", "question": "❓", "info": "ℹ️",
  "warning": "⚠️", "no_entry": "🚫", "prohibited": "🚫",
  "arrows_clockwise": "🔃", "repeat": "🔁", "arrows": "↔️",
  "up": "⬆️", "down": "⬇️", "left": "⬅️", "right": "➡️",
  "end": "🔚", "back": "🔙", "soon": "🔜", "top": "🔝",
  "tm": "™️", "copyright": "©️", "registered": "®️",
};

var emojiAutocompleteOpen = false;
var emojiAutocompleteIdx = -1;

function getEmojiShortcodeAtCursor(input) {
  var start = input.selectionStart;
  var val = input.value;
  if (start === null || start === 0) return null;
  var before = val.slice(0, start);
  var colonIdx = before.lastIndexOf(":");
  if (colonIdx === -1) return null;
  var keyword = before.slice(colonIdx + 1);
  if (keyword.length === 0 || keyword.length > 30) return null;
  if (!/^[a-zA-Z0-9_]+$/.test(keyword)) return null;
  return { keyword: keyword, start: colonIdx, end: start };
}

function filterEmojiResults(keyword) {
  var lower = keyword.toLowerCase();
  var results = [];
  for (var shortcode in EMOJI_MAP) {
    if (shortcode.includes(lower)) {
      results.push({ shortcode: shortcode, emoji: EMOJI_MAP[shortcode] });
    }
  }
  results.sort(function (a, b) {
    var aStarts = a.shortcode.indexOf(lower) === 0;
    var bStarts = b.shortcode.indexOf(lower) === 0;
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;
    return a.shortcode.localeCompare(b.shortcode);
  });
  return results.slice(0, 12);
}

function showEmojiAutocomplete(results) {
  var dropdown = $("#emojiAutocomplete");
  emojiAutocompleteOpen = results.length > 0;
  emojiAutocompleteIdx = -1;
  if (!emojiAutocompleteOpen) {
    dropdown.hide();
    return;
  }
  dropdown.empty();
  results.forEach(function (r, i) {
    var item = $(
      '<div class="emoji-ac-item" data-index="' +
        i +
        '" data-shortcode="' +
        r.shortcode +
        '"><span class="emoji-ac-emoji">' +
        r.emoji +
        '</span>:<span class="emoji-ac-code">' +
        r.shortcode +
        "</span>:</div>",
    );
    item.on("click", function () {
      insertEmojiAutocomplete($(this).data("shortcode"));
    });
    dropdown.append(item);
  });
  dropdown.show();
}

function insertEmojiAutocomplete(shortcode) {
  var input = document.getElementById("messageInput");
  if (!input) return;
  var info = getEmojiShortcodeAtCursor(input);
  if (!info) return;
  var emoji = EMOJI_MAP[shortcode] || "";
  if (!emoji) return;
  var val = input.value;
  var before = val.slice(0, info.start);
  var after = val.slice(info.end);
  input.value = before + emoji + after;
  var pos = info.start + emoji.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  closeEmojiAutocomplete();
}

function closeEmojiAutocomplete() {
  emojiAutocompleteOpen = false;
  emojiAutocompleteIdx = -1;
  $("#emojiAutocomplete").hide();
}

$(document).ready(function () {
  $("#messageInput").on("input", function () {
    var info = getEmojiShortcodeAtCursor(this);
    if (!info) {
      closeEmojiAutocomplete();
      return;
    }
    var results = filterEmojiResults(info.keyword);
    showEmojiAutocomplete(results);
  });

  $("#messageInput").on("keydown", function (e) {
    if (!emojiAutocompleteOpen) return;
    var items = $("#emojiAutocomplete .emoji-ac-item");
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      emojiAutocompleteIdx = (emojiAutocompleteIdx + 1) % items.length;
      items.removeClass("is-highlighted");
      items.eq(emojiAutocompleteIdx).addClass("is-highlighted");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      emojiAutocompleteIdx =
        (emojiAutocompleteIdx - 1 + items.length) % items.length;
      items.removeClass("is-highlighted");
      items.eq(emojiAutocompleteIdx).addClass("is-highlighted");
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (emojiAutocompleteIdx >= 0 && emojiAutocompleteIdx < items.length) {
        e.preventDefault();
        var sc = items.eq(emojiAutocompleteIdx).data("shortcode");
        if (sc) insertEmojiAutocomplete(sc);
      }
    } else if (e.key === "Escape") {
      closeEmojiAutocomplete();
    }
  });

  $(document).on("click", function (e) {
    if (
      emojiAutocompleteOpen &&
      !$(e.target).closest("#emojiAutocomplete").length &&
      !$(e.target).closest("#messageInput").length
    ) {
      closeEmojiAutocomplete();
    }
  });
});

/* ==============================================
   EMOJI PICKER — send bar
   ============================================== */
var emojiPickerInstance = null;
var emojiPickerOpen = false;

function initEmojiPicker() {
  var container = document.getElementById("emoji-picker-container");
  if (!container || typeof EmojiMart === "undefined") return;

  emojiPickerInstance = new EmojiMart.Picker({
    onEmojiSelect: function (emoji) {
      var input = document.getElementById("messageInput");
      if (!input) return;
      var start = input.selectionStart || input.value.length;
      var end = input.selectionEnd || input.value.length;
      input.value =
        input.value.slice(0, start) + emoji.native + input.value.slice(end);
      input.focus();
      input.setSelectionRange(
        start + emoji.native.length,
        start + emoji.native.length,
      );
      closeEmojiPicker();
    },
    theme: "dark",
    set: "native",
    previewPosition: "none",
    skinTonePosition: "none",
    navPosition: "bottom",
    perLine: 8,
  });

  container.appendChild(emojiPickerInstance);
}

function openEmojiPicker() {
  var container = document.getElementById("emoji-picker-container");
  if (!container) return;
  if (!emojiPickerInstance) initEmojiPicker();
  container.style.display = "block";
  emojiPickerOpen = true;
  $("#emojiBtn").addClass("active");
}

function closeEmojiPicker() {
  var container = document.getElementById("emoji-picker-container");
  if (container) container.style.display = "none";
  emojiPickerOpen = false;
  $("#emojiBtn").removeClass("active");
}

$(document).ready(function () {
  // Toggle emoji picker on button click
  $("#emojiBtn").on("click", function (e) {
    e.stopPropagation();
    if (emojiPickerOpen) {
      closeEmojiPicker();
    } else {
      openEmojiPicker();
    }
  });

  // Close picker when clicking outside
  $(document).on("click.emojipicker", function (e) {
    if (
      emojiPickerOpen &&
      !$(e.target).closest("#emoji-picker-container").length &&
      !$(e.target).closest("#emojiBtn").length
    ) {
      closeEmojiPicker();
    }
  });

  // Close picker on Escape
  $(document).on("keydown.emojipicker", function (e) {
    if (e.key === "Escape" && emojiPickerOpen) closeEmojiPicker();
  });
});

/* ==============================================
   REACTION PICKER — context menu "more" button
   ============================================== */
var reactionPickerInstance = null;
var reactionPickerTargetId = null;

function initReactionPicker() {
  var container = document.getElementById("reaction-picker-container");
  if (!container || typeof EmojiMart === "undefined") return;

  reactionPickerInstance = new EmojiMart.Picker({
    onEmojiSelect: function (emoji) {
      closeReactionPicker();
      if (reactionPickerTargetId) {
        sendReaction(reactionPickerTargetId, emoji.native);
      }
    },
    theme: "dark",
    set: "native",
    previewPosition: "none",
    skinTonePosition: "none",
    navPosition: "bottom",
    perLine: 7,
  });

  container.appendChild(reactionPickerInstance);
}

function openReactionPicker(messageId, anchorX, anchorY) {
  var container = document.getElementById("reaction-picker-container");
  if (!container) return;
  if (!reactionPickerInstance) initReactionPicker();

  reactionPickerTargetId = messageId;

  // Position near the context menu
  var pickerW = 320;
  var pickerH = 360;
  var left = Math.min(anchorX, window.innerWidth - pickerW - 12);
  var top = Math.min(anchorY, window.innerHeight - pickerH - 12);
  left = Math.max(8, left);
  top = Math.max(8, top);

  container.style.left = left + "px";
  container.style.top = top + "px";
  container.style.display = "block";

  // Close context menu
  $("#msg-context-menu").removeClass("show");
}

function closeReactionPicker() {
  var container = document.getElementById("reaction-picker-container");
  if (container) container.style.display = "none";
  reactionPickerTargetId = null;
}

$(document).ready(function () {
  // "More reactions" button in context menu
  $("#menu-react-more").on("click", function (e) {
    e.stopPropagation();
    if (!contextMenuTargetId) return;
    var rect = document
      .getElementById("msg-context-menu")
      .getBoundingClientRect();
    openReactionPicker(contextMenuTargetId, rect.right + 8, rect.top);
  });

  // Quick-react buttons in context menu
  $(document).on(
    "click",
    ".quick-react-btn:not(.quick-react-more)",
    function (e) {
      e.stopPropagation();
      var emoji = $(this).data("emoji");
      if (!emoji || !contextMenuTargetId) return;
      $("#msg-context-menu").removeClass("show");
      sendReaction(contextMenuTargetId, emoji);
    },
  );

  // Close reaction picker when clicking outside
  $(document).on("click.reactionpicker", function (e) {
    var container = document.getElementById("reaction-picker-container");
    if (
      container &&
      container.style.display !== "none" &&
      !$(e.target).closest("#reaction-picker-container").length &&
      !$(e.target).closest("#menu-react-more").length
    ) {
      closeReactionPicker();
    }
  });

  $(document).on("keydown.reactionpicker", function (e) {
    if (e.key === "Escape") closeReactionPicker();
  });
});

/* ==============================================
   REACTIONS — send / toggle
   ============================================== */

/**
 * Send or toggle a reaction via REST.
 * If the user already reacted with this emoji → DELETE (toggle off).
 * Otherwise → POST (add/replace).
 */
function sendReaction(messageId, emoji) {
  if (!messageId || !emoji) return;

  // Check current state from the DOM pill
  var row = $("#msg-" + messageId);
  var existingPill = row.find(".reaction-pill").filter(function () {
    return $(this).attr("data-emoji") === emoji;
  });
  var alreadyReacted = existingPill.hasClass("reacted-by-me");

  if (alreadyReacted) {
    // Toggle off — DELETE
    $.ajax({
      url:
        "/api/messages/" +
        messageId +
        "/reactions/" +
        encodeURIComponent(emoji),
      method: "DELETE",
      error: function () {
        showToast("Could not remove reaction", "error");
      },
    });
  } else {
    // Add / replace — POST
    $.ajax({
      url: "/api/messages/" + messageId + "/reactions",
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({ emoji: emoji }),
      error: function () {
        showToast("Could not add reaction", "error");
      },
    });
  }
}

/* ==============================================
   REACTIONS — render pills
   ============================================== */

/**
 * Re-render all reaction pills for a message.
 * reactions = [{emoji, count, reactedByMe}, ...]
 */
function renderReactionPills(containerEl, reactions, messageId) {
  if (!containerEl) return;
  var $c = $(containerEl);
  $c.empty();

  if (!reactions || reactions.length === 0) return;

  reactions.forEach(function (r) {
    var pill = $('<button class="reaction-pill" type="button"></button>');
    pill.attr("data-emoji", r.emoji);
    pill.attr("data-msg-id", messageId);
    pill.attr(
      "title",
      r.reactedByMe ? "Remove reaction" : "React with " + r.emoji,
    );
    if (r.reactedByMe) pill.addClass("reacted-by-me");

    pill.append('<span class="reaction-pill-emoji">' + r.emoji + "</span>");
    pill.append('<span class="reaction-pill-count">' + r.count + "</span>");

    pill.on("click", function (e) {
      e.stopPropagation();
      sendReaction(messageId, r.emoji);
    });

    $c.append(pill);
  });
}

/**
 * Called when a REACTION WebSocket update arrives.
 * Updates the pills for the affected message in real time.
 */
function handleReactionUpdate(messageId, reactions) {
  if (!messageId) return;
  var row = $("#msg-" + messageId);
  if (!row.length) return;

  var container = row.find('.msg-reactions[data-msg-id="' + messageId + '"]');
  if (!container.length) return;

  // Animate new pills
  var oldEmojis = {};
  container.find(".reaction-pill").each(function () {
    oldEmojis[$(this).data("emoji")] = true;
  });

  renderReactionPills(container[0], reactions, messageId);

  // Add pop animation to newly appeared pills
  container.find(".reaction-pill").each(function () {
    var e = $(this).data("emoji");
    if (!oldEmojis[e]) {
      $(this).addClass("reaction-pill--new");
    }
  });
}

/* ==============================================
   ATTACHMENT MENU TOGGLE
   ============================================== */
$(document).ready(function () {
  var attachmentMenuOpen = false;

  $("#attachmentToggleBtn").on("click", function (e) {
    e.stopPropagation();
    var menu = $("#attachment-menu");

    if (attachmentMenuOpen) {
      menu.hide();
      attachmentMenuOpen = false;
    } else {
      // Check if we are in private chat for schedule button
      if (selectedUser !== "public" && activeGroupId == null) {
        $("#attachment-menu #scheduleBtn").show();
      } else {
        $("#attachment-menu #scheduleBtn").hide();
      }

      menu.show();
      attachmentMenuOpen = true;
    }
  });

  $(document).on("click", function (e) {
    if (
      attachmentMenuOpen &&
      !$(e.target).closest("#attachment-menu").length &&
      !$(e.target).closest("#attachmentToggleBtn").length
    ) {
      $("#attachment-menu").hide();
      attachmentMenuOpen = false;
    }
  });

  // Close menu when an item is clicked
  $(".attachment-menu-item").on("click", function () {
    $("#attachment-menu").hide();
    attachmentMenuOpen = false;
  });
});
