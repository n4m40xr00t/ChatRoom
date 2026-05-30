/**
 * Call Integration for Chat Page
 *
 * Adds video and audio call functionality to the chat interface
 * and handles call notifications.
 */

(function () {
  "use strict";

  let callManager = null;
  let currentChatUser = null;

  // ── Call-ring state ────────────────────────────────────────────────────────
  // When the caller sends /app/call-ring from the chat page, the server returns
  // CALL_RINGING with a callId. We capture it here so the call window URL can
  // include it (allowing the call window to attach its SDP to the existing session).
  let _ringResolve = null; // resolve(callId) or resolve(null) on error/timeout
  let _ringTimer = null;

  /**
   * Patch the callManager's handleCallSignal so we can intercept CALL_RINGING
   * (which carries the callId created by /call-ring) and error responses.
   * Must be called once, right after callManager is created.
   */
  function patchCallManagerForRing() {
    if (!callManager) return;
    const orig = callManager.handleCallSignal.bind(callManager);
    callManager.handleCallSignal = async function (signal) {
      if (_ringResolve) {
        if (signal.signalType === "CALL_RINGING") {
          clearTimeout(_ringTimer);
          const resolve = _ringResolve;
          _ringResolve = null;
          await orig(signal); // still update currentCallId etc.
          resolve(signal.callId); // hand back the callId to initiateCall()
          return;
        }
        if (
          ["CALL_UNAVAILABLE", "CALL_ERROR", "CALL_BUSY"].includes(
            signal.signalType,
          )
        ) {
          clearTimeout(_ringTimer);
          const resolve = _ringResolve;
          _ringResolve = null;
          await orig(signal); // shows the toast / error notification
          resolve(null); // signal that the call cannot proceed
          return;
        }
      }
      await orig(signal);
    };
  }

  /**
   * Send /app/call-ring via the chat page's WebSocket and wait for the callId.
   * Returns the callId string on success, or null if rejected / timed out.
   */
  async function ringCallee(targetUser, callType) {
    // Pre-flight: clean up any stale "ringing" sessions from a previous crash
    // so the server doesn't falsely reject with "already in active call".
    try { await fetch("/api/calls/cleanup", { method: "POST" }); } catch (_) {}

    return new Promise((resolve) => {
      // Use the robust client check — .connected can be unreliable on StompJS 2.3.3
      const client = window.stompClient;
      const isConnected = client && (client.connected || (client.ws && client.ws.readyState === 1));
      if (!isConnected) {
        console.warn("[CallIntegration] ringCallee: STOMP not connected, proceeding without callId");
        resolve(null);
        return;
      }

      _ringResolve = resolve;
      _ringTimer = setTimeout(() => {
        _ringResolve = null;
        _ringTimer = null;
        resolve(null); // timed out — let the call window handle it
      }, 8000);

      client.send(
        "/app/call-ring",
        {},
        JSON.stringify({
          callee: targetUser,
          callType: callType,
          signalType: "CALL_OFFER", // signalType field is required by the server payload
        }),
      );
    });
  }

  /**
   * Initialize call integration
   */
  function initCallIntegration() {
    console.log("Initializing call integration...");

    // Wait for STOMP client to be available
    const checkStompInterval = setInterval(() => {
      // StompJS 2.3.3 might not reliably expose .connected on the window object depending on scoping, 
      // or we might need to check the underlying WebSocket state.
      // We also check window.stompClient or just the global stompClient variable.
      const client = window.stompClient || (typeof stompClient !== 'undefined' ? stompClient : null);
      
      if (client) {
        // Check both the Stomp.js .connected property and the underlying SockJS readyState (1 = OPEN)
        const isConnected = client.connected || (client.ws && client.ws.readyState === 1);
        if (isConnected) {
          clearInterval(checkStompInterval);
          // Ensure we pass the resolved client to setupCallManager if we want
          window.stompClient = client; // enforce it on window
          setupCallManager();
        }
      }
    }, 500);

    // Bind call button events
    bindCallButtons();

    // Listen for user selection changes
    observeUserSelection();
  }

  /**
   * Setup WebRTC call manager
   */
  function setupCallManager() {
    const userMeta = document.getElementById("currentUsername");
    const username = userMeta ? (userMeta.content || userMeta.getAttribute("content")) : null;
    if (!username || !window.stompClient) {
      console.error(
        "Cannot initialize call manager: missing username or STOMP client",
      );
      return;
    }

    callManager = new WebRTCCallManager(window.stompClient, username);
    patchCallManagerForRing();
    console.log("Call manager initialized successfully");
  }

  /**
   * Bind call button events
   */
  function bindCallButtons() {
    const audioCallBtn = document.getElementById("audio-call-btn");
    const videoCallBtn = document.getElementById("video-call-btn");

    if (audioCallBtn) {
      audioCallBtn.addEventListener("click", () => {
        if (
          currentChatUser &&
          currentChatUser !== "public" &&
          !currentChatUser.startsWith("group-")
        ) {
          initiateCall(currentChatUser, "audio");
        }
      });
    }

    if (videoCallBtn) {
      videoCallBtn.addEventListener("click", () => {
        if (
          currentChatUser &&
          currentChatUser !== "public" &&
          !currentChatUser.startsWith("group-")
        ) {
          initiateCall(currentChatUser, "video");
        }
      });
    }
  }

  /**
   * Observe user selection changes
   */
  function observeUserSelection() {
    // Hook into the existing selectUser function
    const originalSelectUser = window.selectUser;
    if (typeof originalSelectUser === "function") {
      window.selectUser = function (username) {
        // Call original function
        originalSelectUser.apply(this, arguments);

        // Update current chat user
        currentChatUser = username;

        // Show/hide call buttons based on chat type
        updateCallButtonsVisibility(username);
      };
    } else {
      // If selectUser doesn't exist yet, try again later
      setTimeout(observeUserSelection, 1000);
    }

    // Also hook into selectGroupChat to hide call buttons in groups
    const originalSelectGroupChat = window.selectGroupChat;
    if (typeof originalSelectGroupChat === "function") {
      window.selectGroupChat = function (id) {
        originalSelectGroupChat.apply(this, arguments);
        currentChatUser = "group-" + id;
        updateCallButtonsVisibility(currentChatUser);
      };
    }
  }

  /**
   * Check if a contact is online by inspecting the presence dot in the sidebar
   */
  function isContactOnline(username) {
    const contactItem = document.getElementById("contact-item-" + username);
    if (!contactItem) return false;
    const dot = contactItem.querySelector(".cr-contact-online-dot");
    return dot !== null && !dot.classList.contains("cr-contact-offline-dot");
  }

  /**
   * Check online status via the profile API.
   * The profile endpoint is dedicated and always reflects the live DB value.
   * Falls back to contacts API and then DOM inspection.
   */
  async function checkUserOnlineRealtime(username) {
    // Primary: dedicated profile endpoint (reflects SessionConnectEvent updates)
    try {
      const res = await fetch(
        "/api/user/" + encodeURIComponent(username) + "/profile",
      );
      if (res.ok) {
        const data = await res.json();
        // data.online is a boolean from the server
        if (data.online === true || data.online === "true") return true;
        if (data.online === false || data.online === "false") return false;
      }
    } catch (e) {
      /* fall through */
    }

    // Secondary: contacts list
    try {
      const res2 = await fetch("/api/contacts");
      if (res2.ok) {
        const contacts = await res2.json();
        const user = contacts.find((c) => c.username === username);
        if (user) return user.online === "true";
      }
    } catch (e) {
      /* fall through */
    }

    // Last resort: DOM presence dot
    return isContactOnline(username);
  }

  /**
   * Update call buttons visibility
   */
  function updateCallButtonsVisibility(username) {
    const audioCallBtn = document.getElementById("audio-call-btn");
    const videoCallBtn = document.getElementById("video-call-btn");

    if (!audioCallBtn || !videoCallBtn) return;

    // Show buttons only for private chats (not public or groups)
    if (username === "public" || !username || username.startsWith("group-")) {
      audioCallBtn.style.display = "none";
      videoCallBtn.style.display = "none";
    } else {
      // Show call buttons regardless of online status — server will reject if offline
      audioCallBtn.style.display = "flex";
      videoCallBtn.style.display = "flex";
    }
  }

  /**
   * Initiate a call
   */
  async function initiateCall(targetUser, callType) {
    if (!callManager) {
      showNotification(
        "Call system not ready. Please refresh the page.",
        "error",
      );
      return;
    }

    if (!targetUser || targetUser === "public") {
      showNotification("Cannot call in public chat", "warning");
      return;
    }

    if (targetUser.startsWith("group-")) {
      showNotification("Group calls are not available yet", "info");
      return;
    }

    // Pre-flight: mediaDevices is only available in secure contexts (HTTPS / localhost).
    // Catch this early so the user gets a helpful message instead of a blank call window.
    const mediaDevicesAvailable =
      (navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function") ||
      typeof navigator.getUserMedia === "function" ||
      typeof navigator.webkitGetUserMedia === "function";

    if (!mediaDevicesAvailable) {
      if (window.isSecureContext === false) {
        showNotification(
          "Calls require HTTPS. Please open the app via https:// or ask your admin to enable SSL.",
          "error",
        );
      } else {
        showNotification(
          "Your browser does not support video calls. Please try Chrome or Firefox.",
          "error",
        );
      }
      return;
    }

    console.log(`Initiating ${callType} call to ${targetUser}`);

    // ── Step 1: Ring the callee IMMEDIATELY from the chat page's WebSocket ──
    // This sends a signal with no SDP — just enough to show the callee's
    // notification modal right now, without waiting for ICE gathering.
    // The server validates online status, blocks, busy state, etc. here.
    const callId = await ringCallee(targetUser, callType);

    // If the server rejected the call (offline, blocked, busy) ringCallee() already
    // showed a toast via the normal signal handler — just stop here.
    if (callId === null && _ringTimer === null) {
      // _ringTimer is null only when the promise resolved normally (not timed out)
      return;
    }

    console.log(`Call ring sent. callId=${callId || "(none)"}`);

    // ── Step 2: Open the call window which handles SDP + ICE ──
    // Pass the callId so the window can attach its SDP to the pre-established session.
    let callUrl = `/call?user=${encodeURIComponent(targetUser)}&type=${callType}`;
    if (callId) callUrl += `&callId=${encodeURIComponent(callId)}`;

    const callWindow = window.open(
      callUrl,
      "cr-call-window",
      "width=1280,height=800,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes",
    );

    if (!callWindow || callWindow.closed) {
      showNotification("Opening call in this tab (popups blocked)", "info");
      setTimeout(() => {
        window.location.href = callUrl;
      }, 1200);
    } else {
      callWindow.focus();
    }
  }

  /**
   * Show notification — delegates to chat.js showToast if available
   */
  function showNotification(message, type = "info") {
    if (window.showToast) {
      window.showToast(message, type);
      return;
    }
    console.log(`[CALL ${type.toUpperCase()}] ${message}`);
    const notification = document.createElement("div");
    notification.textContent = message;
    const colorMap = {
      error: "#dc2626",
      warning: "#d97706",
      success: "#16a34a",
      info: "#2563eb",
    };
    notification.style.cssText = [
      "position:fixed",
      "top:72px",
      "right:18px",
      `background:${colorMap[type] || "#2563eb"}`,
      "color:#fff",
      "padding:12px 18px",
      "border-radius:10px",
      "box-shadow:0 4px 18px rgba(0,0,0,0.35)",
      "z-index:10200",
      "font-size:14px",
      "font-weight:500",
      "max-width:320px",
      "font-family:Poppins,sans-serif",
      "animation:slideInRight 0.28s ease",
    ].join(";");
    document.body.appendChild(notification);
    setTimeout(() => {
      notification.style.opacity = "0";
      notification.style.transition = "opacity 0.25s ease";
      setTimeout(() => notification.remove(), 280);
    }, 3200);
  }

  // Add CSS animations
  const style = document.createElement("style");
  style.textContent = `
        @keyframes slideInRight {
            from {
                transform: translateX(400px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }

        @keyframes slideOutRight {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(400px);
                opacity: 0;
            }
        }
    `;
  document.head.appendChild(style);

  // Expose initiateCall globally so tooltip buttons can use it
  window.initiateCall = initiateCall;

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCallIntegration);
  } else {
    initCallIntegration();
  }
})();
