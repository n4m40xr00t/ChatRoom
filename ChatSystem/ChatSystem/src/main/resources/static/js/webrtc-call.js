/**
 * WebRTC Video & Voice Call Module
 *
 * Handles peer-to-peer audio and video calls using WebRTC API.
 * Uses the existing WebSocket/STOMP infrastructure for signaling.
 *
 * Features:
 * - Audio and video calls
 * - Mute/unmute audio
 * - Enable/disable video
 * - Call controls (answer, reject, hang up)
 * - Automatic ICE candidate exchange
 * - Full ICE-gathering wait before sending offer/answer SDP
 * - Call status notifications
 *
 * Security:
 * - Validates user permissions via backend
 * - Checks for blocked users
 * - Prevents concurrent calls
 */

/**
 * Cross-browser, secure-context-aware getUserMedia wrapper.
 *
 * Priority:
 *   1. navigator.mediaDevices.getUserMedia  — modern, requires HTTPS or localhost
 *   2. navigator.webkitGetUserMedia / mozGetUserMedia — legacy prefixed API
 *
 * If mediaDevices is missing AND the page is NOT a secure context, throws an
 * InsecureContextError with a clear, actionable message so the UI can guide the user.
 */
function getUserMediaSafe(constraints) {
  // ── Modern API (Chrome 47+, FF 36+, Safari 11+) ─────────────────────────
  if (
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  ) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  // ── Polyfill mediaDevices on older browsers ──────────────────────────────
  // Some browsers expose the legacy API but not the mediaDevices object.
  const legacyGUM =
    navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia ||
    navigator.msGetUserMedia;

  if (legacyGUM) {
    // Wrap callback-based API in a Promise
    return new Promise((resolve, reject) => {
      legacyGUM.call(navigator, constraints, resolve, reject);
    });
  }

  // ── Neither available — detect WHY ──────────────────────────────────────
  // window.isSecureContext is false on plain HTTP (non-localhost) origins.
  // This is the most common reason on Android Chrome over a LAN IP.
  if (window.isSecureContext === false) {
    const e = new Error(
      "Camera and microphone access requires a secure connection (HTTPS). " +
        "Please open the app via https:// or ask your administrator to enable SSL.",
    );
    e.name = "InsecureContextError";
    return Promise.reject(e);
  }

  const e = new Error(
    "Your browser does not support camera or microphone access. Please try Chrome or Firefox.",
  );
  e.name = "NotSupportedError";
  return Promise.reject(e);
}

/**
 * Converts a raw media / WebRTC error into a human-readable string.
 * Covers the most common failure modes on mobile browsers.
 */
function friendlyMediaError(error) {
  switch (error.name) {
    case "InsecureContextError":
      return (
        "Calls require a secure connection (HTTPS). " +
        "Please open the app via https:// or ask your admin to enable SSL."
      );
    case "NotSupportedError":
      return "Your browser does not support video calls. Please try the latest Chrome or Firefox.";
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera / microphone permission denied. Tap the lock icon in your address bar and allow access, then try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera or microphone found. Check that your device has one and it is not blocked.";
    case "NotReadableError":
    case "TrackStartError":
      return "Camera or microphone is in use by another app. Close it and try again.";
    case "OverconstrainedError":
      return "Camera does not support the requested resolution. Try an audio-only call.";
    case "AbortError":
      return "Media access was interrupted. Please try again.";
    default:
      // Includes the raw message so unknown errors are still debuggable
      return (
        "Could not access camera / microphone: " + (error.message || error)
      );
  }
}

class WebRTCCallManager {
  constructor(stompClient, username) {
    this.stompClient = stompClient;
    this.username = username;
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.currentCallId = null;
    this.currentCallType = null;
    this.isCallActive = false;
    this.isCaller = false;
    this.remotePeer = null;
    this.pendingOffer = null;

    // WebRTC configuration with STUN + TURN servers for NAT traversal.
    // TURN servers are essential when both peers are behind NAT (e.g. cloud / mobile).
    // Using free public TURN servers from openrelay.metered.ca — no registration needed.
    this.rtcConfig = {
      iceServers: [
        // Google STUN (fast, good for same-network calls)
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        // Open Relay free TURN servers — required for cross-NAT / cloud deployment
        {
          urls: "turn:openrelay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
        {
          urls: "turn:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
        {
          urls: "turn:openrelay.metered.ca:443?transport=tcp",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
        {
          urls: "turns:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
      ],
      iceCandidatePoolSize: 10,
      iceTransportPolicy: "all",  // 'all' = try direct first, then TURN
    };

    this.initializeUI();
    this.subscribeToCallSignals();
  }

  /**
   * Initialize call UI elements.
   * On the /call page the overlay already exists in the HTML — do NOT inject a second copy.
   * Optional chaining on all addEventListener calls ensures safe no-ops when elements are absent.
   */
  initializeUI() {
    const isCallPage = window.location.pathname === "/call";

    if (!isCallPage) {
      // Inject call overlay HTML only on non-call pages (e.g. chat page)
      const callOverlayHTML = `
                <div id="call-overlay" class="call-overlay hidden">
                    <div class="call-container">
                        <div class="call-header">
                            <span id="call-status">Connecting...</span>
                            <span id="call-duration">00:00</span>
                        </div>

                        <div class="video-container">
                            <video id="remote-video" autoplay playsinline></video>
                            <video id="local-video" autoplay playsinline muted></video>
                        </div>

                        <div class="call-info">
                            <div id="remote-peer-name"></div>
                            <div id="call-state-text">Calling...</div>
                        </div>

                        <div class="call-controls">
                            <button id="toggle-audio" class="call-btn" title="Mute/Unmute">
                                <i class="fas fa-microphone"></i>
                            </button>
                            <button id="toggle-video" class="call-btn" title="Camera On/Off">
                                <i class="fas fa-video"></i>
                            </button>
                            <button id="hang-up" class="call-btn hang-up" title="End Call">
                                <i class="fas fa-phone-slash"></i>
                            </button>
                        </div>

                        <div id="incoming-call-controls" class="incoming-call-controls hidden">
                            <button id="accept-call" class="call-btn accept">
                                <i class="fas fa-phone"></i> Accept
                            </button>
                            <button id="reject-call" class="call-btn reject">
                                <i class="fas fa-phone-slash"></i> Reject
                            </button>
                        </div>
                    </div>
                </div>
            `;
      document.body.insertAdjacentHTML("beforeend", callOverlayHTML);
    }

    // Bind call-control buttons ONLY on non-call pages (chat page overlay etc.).
    // On the dedicated /call page, call.html already binds these buttons with full UI
    // state logic. Binding them here too would cause every click to fire twice, which
    // double-toggles the audio/video track back to its original state — the mute bug.
    if (!isCallPage) {
      document
        .getElementById("toggle-audio")
        ?.addEventListener("click", () => this.toggleAudio());
      document
        .getElementById("toggle-video")
        ?.addEventListener("click", () => this.toggleVideo());
      document
        .getElementById("hang-up")
        ?.addEventListener("click", () => this.endCall());
      document
        .getElementById("accept-call")
        ?.addEventListener("click", () => this.acceptCall());
      document
        .getElementById("reject-call")
        ?.addEventListener("click", () => this.rejectCall());
    }

    // Notification modal buttons (chat.html only — absent on /call page)
    const notificationModal = document.getElementById(
      "call-notification-modal",
    );
    if (notificationModal) {
      document
        .getElementById("accept-call-btn")
        ?.addEventListener("click", () => this.acceptCall());
      document
        .getElementById("decline-call-btn")
        ?.addEventListener("click", () => this.rejectCall());
      document
        .getElementById("call-notification-close")
        ?.addEventListener("click", () => this.rejectCall());
    }
  }

  /**
   * Subscribe to call signaling messages via WebSocket
   */
  subscribeToCallSignals() {
    // Use direct broker path "/user/{username}/call" — this matches exactly what
    // convertAndSendToUser(username, "/call", ...) sends to the broker.
    // This is the same pattern chat.js uses for "/user/{username}/private" messages
    // and is more reliable than the user-destination translation path "/user/call".
    this.stompClient.subscribe(
      "/user/" + this.username + "/call",
      (message) => {
        const signal = JSON.parse(message.body);
        this.handleCallSignal(signal);
      },
    );
  }

  /**
   * Handle incoming call signals
   */
  async handleCallSignal(signal) {
    console.log("Call signal received:", signal.signalType, signal);

    switch (signal.signalType) {
      case "CALL_OFFER":
        if (
          this.currentCallId &&
          signal.callId === this.currentCallId &&
          signal.sdp &&
          !this.pendingOffer
        ) {
          // SDP update for an already-ringing call: /call-ring notified us first,
          // now the caller's call window is delivering the actual SDP.
          this.pendingOffer = signal.sdp;
        } else if (!this.isCallActive) {
          // New incoming call (ring notification with or without SDP)
          await this.handleIncomingCall(signal);
        }
        break;
      case "CALL_ANSWER":
        await this.handleCallAnswer(signal);
        break;
      case "CALL_ICE_CANDIDATE":
        await this.handleIceCandidate(signal);
        break;
      case "CALL_RINGING":
        // Store callId so subsequent ICE-candidate signals have a valid callId
        this.currentCallId = signal.callId || this.currentCallId;
        this.updateCallStatus("Ringing...");
        break;
      case "CALL_ACCEPTED":
        this.updateCallStatus("Connected");
        this.startCallTimer();
        break;
      case "CALL_REJECTED":
        this.showNotification("Call rejected", "warning");
        this.closeCall();
        break;
      case "CALL_ENDED":
        this.showNotification("Call ended", "info");
        this.closeCall();
        break;
      case "CALL_BUSY":
        this.showNotification("User is busy", "warning");
        this.closeCall();
        break;
      case "CALL_UNAVAILABLE":
        this.showNotification("User is unavailable", "warning");
        this.closeCall();
        break;
      case "CALL_TIMEOUT":
        this.showNotification("Call timeout", "warning");
        this.closeCall();
        break;
      case "CALL_ERROR":
        this.showNotification(signal.errorMessage || "Call error", "error");
        this.closeCall();
        break;
    }
  }

  /**
   * Initiate a call to another user.
   * Waits for full ICE gathering before sending the CALL_OFFER so the SDP
   * already contains all ICE candidates (no separate trickle required).
   */
  async initiateCall(targetUser, callType = "video", existingCallId = null) {
    if (this.isCallActive) {
      this.showNotification("You are already in a call", "warning");
      return;
    }

    try {
      this.isCaller = true;
      this.remotePeer = targetUser;
      this.currentCallType = callType;

      // Store the pre-established callId immediately so endCall() can send CALL_END
      // even before we receive CALL_RINGING from the server.
      // Without this, currentCallId stays null for pre-ring sessions and the hang-up
      // signal is never sent — leaving the server session stuck in "ringing" state.
      if (existingCallId) {
        this.currentCallId = existingCallId;
      }

      // Request media permissions
      await this.getLocalStream(callType);

      // Show call UI
      this.showCallOverlay();
      this.updateCallStatus("Calling " + targetUser + "...");
      const remotePeerNameEl = document.getElementById("remote-peer-name");
      if (remotePeerNameEl) remotePeerNameEl.textContent = targetUser;

      // Create peer connection
      this.createPeerConnection();

      // Create offer
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: callType === "video",
      });

      await this.peerConnection.setLocalDescription(offer);

      // Wait for all ICE candidates to be gathered into the SDP
      await this.waitForIceGathering();

      // Send offer with fully-populated SDP.
      // If existingCallId is provided the server will update the pre-established session
      // (created by /call-ring from the chat page) instead of creating a new one.
      this.sendCallSignal({
        callee: targetUser,
        callType: callType,
        signalType: "CALL_OFFER",
        sdp: this.peerConnection.localDescription.sdp,
        callId: existingCallId || undefined,
      });

      this.isCallActive = true;
    } catch (error) {
      console.error("Error initiating call:", error);
      this.showNotification(friendlyMediaError(error), "error");
      this.closeCall();
    }
  }

  /**
   * Handle incoming call offer
   */
  async handleIncomingCall(signal) {
    if (this.isCallActive) {
      // Already in a call — tell the caller we're busy
      this.sendCallSignal({
        callId: signal.callId,
        signalType: "CALL_REJECT",
      });
      return;
    }

    this.isCaller = false;
    this.currentCallId = signal.callId;
    this.currentCallType = signal.callType;
    this.remotePeer = signal.caller;

    // Show incoming call notification modal (chat page flow)
    this.showCallNotificationModal(signal.caller, signal.callType);

    // Play ringtone
    this.playRingtone();

    // Store offer SDP for use when the user accepts the call.
    // May be null when this is the /call-ring notification (SDP arrives later via /call-offer).
    this.pendingOffer = signal.sdp || null;
  }

  /**
   * Show the incoming call notification modal (chat.html)
   */
  showCallNotificationModal(callerName, callType) {
    const modal = document.getElementById("call-notification-modal");
    if (!modal) return;

    const nameEl = document.getElementById("caller-name");
    if (nameEl) nameEl.textContent = callerName;

    const typeIcon = modal.querySelector(".call-video-icon");
    const typeLabel = modal.querySelector(".call-type-label");
    if (typeLabel) {
      typeLabel.textContent =
        callType === "video" ? "Video Call" : "Audio Call";
    }
    if (typeIcon) {
      typeIcon.className =
        callType === "video"
          ? "fi fi-rr-video-camera call-video-icon"
          : "fi fi-rr-phone-call call-video-icon";
    }

    const statusEl = document.getElementById("caller-status");
    if (statusEl) {
      statusEl.textContent =
        callType === "video"
          ? "Incoming video call..."
          : "Incoming audio call...";
    }

    const avatarEl = document.getElementById("caller-avatar");
    if (avatarEl) {
      const initial = callerName ? callerName.charAt(0).toUpperCase() : "?";
      avatarEl.textContent = initial;
      if (window.getAvatarColor) {
        avatarEl.style.background = window.getAvatarColor(callerName);
      }
    }

    modal.style.display = "flex";
  }

  /**
   * Hide the incoming call notification modal
   */
  hideCallNotificationModal() {
    const modal = document.getElementById("call-notification-modal");
    if (!modal) return;
    modal.style.display = "none";
  }

  /**
   * Accept incoming call — stores call data in sessionStorage and navigates to /call page.
   * The actual WebRTC answer flow is handled on the call page (via answerIncomingCall).
   */
  async acceptCall() {
    try {
      this.stopRingtone();
      this.hideCallNotificationModal();

      try {
        sessionStorage.setItem(
          "incomingCall",
          JSON.stringify({
            caller: this.remotePeer,
            callType: this.currentCallType,
            callId: this.currentCallId,
            sdp: this.pendingOffer,
          }),
        );
      } catch (e) {
        // sessionStorage unavailable — the call page will rely on URL params
      }

      const callUrl =
        `/call?user=${encodeURIComponent(this.remotePeer)}&type=${this.currentCallType}&incoming=true` +
        (this.currentCallId
          ? `&callId=${encodeURIComponent(this.currentCallId)}`
          : "");
      window.location.href = callUrl;
    } catch (error) {
      console.error("Error accepting call:", error);
      this.showNotification("Failed to accept call", "error");
      this.closeCall();
    }
  }

  /**
   * Reject incoming call
   */
  rejectCall() {
    this.stopRingtone();
    this.hideCallNotificationModal();

    this.sendCallSignal({
      callId: this.currentCallId,
      signalType: "CALL_REJECT",
    });

    this.closeCall();
  }

  /**
   * Full callee answer flow — called from the /call page after sessionStorage data is restored.
   * Gathers ICE candidates fully before sending the CALL_ANSWER so the SDP is self-contained.
   *
   * @param {string} callId     - The call ID from the original offer
   * @param {string} offerSdp   - The caller's SDP offer string
   * @param {string} callType   - 'video' or 'audio'
   * @returns {Promise<boolean>} Resolves true on success, throws on failure
   */
  async answerIncomingCall(callId, offerSdp, callType) {
    try {
      this.isCaller = false;
      this.currentCallId = callId;
      this.currentCallType = callType || "video";
      this.isCallActive = true;

      await this.getLocalStream(this.currentCallType);
      this.createPeerConnection();

      await this.peerConnection.setRemoteDescription({
        type: "offer",
        sdp: offerSdp,
      });

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      // Wait for complete ICE gathering so SDP contains all candidates
      await this.waitForIceGathering();

      this.sendCallSignal({
        callId: callId,
        signalType: "CALL_ANSWER",
        sdp: this.peerConnection.localDescription.sdp,
      });

      this.startCallTimer();
      this.updateCallStatus("Connected");
      return true;
    } catch (err) {
      this.showNotification(friendlyMediaError(err), "error");
      this.closeCall();
      throw err;
    }
  }

  /**
   * Handle call answer from remote peer (caller side).
   * Sets the remote description and starts the call timer.
   */
  async handleCallAnswer(signal) {
    // Guard: peerConnection may not exist if we received a stale signal
    if (!this.peerConnection) return;

    try {
      this.currentCallId = signal.callId;

      await this.peerConnection.setRemoteDescription({
        type: "answer",
        sdp: signal.sdp,
      });

      this.updateCallStatus("Connected");
      // Start the timer here so it works even without the call.html patch.
      // startCallTimer() is idempotent (guarded against double-start).
      this.startCallTimer();
    } catch (error) {
      console.error("Error handling call answer:", error);
      this.showNotification("Call connection failed", "error");
      this.closeCall();
    }
  }

  /**
   * Handle ICE candidate from remote peer
   */
  async handleIceCandidate(signal) {
    try {
      if (this.peerConnection && signal.iceCandidate) {
        await this.peerConnection.addIceCandidate(
          new RTCIceCandidate(signal.iceCandidate),
        );
      }
    } catch (error) {
      console.error("Error adding ICE candidate:", error);
    }
  }

  /**
   * Create RTCPeerConnection and wire up event handlers
   */
  createPeerConnection() {
    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    // Add local stream tracks to the connection
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // Trickle ICE — also used as a fallback for peers that don't support bundled SDP
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendCallSignal({
          callId: this.currentCallId,
          signalType: "CALL_ICE_CANDIDATE",
          iceCandidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        });
      }
    };

    // Attach incoming remote tracks to the remote video element
    this.peerConnection.ontrack = (event) => {
      console.log("Remote track received:", event.track.kind);
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
        const remoteVideo = document.getElementById("remote-video");
        if (remoteVideo) remoteVideo.srcObject = this.remoteStream;
      }
      this.remoteStream.addTrack(event.track);
    };

    // Close call automatically when connection drops
    this.peerConnection.onconnectionstatechange = () => {
      console.log("Connection state:", this.peerConnection.connectionState);
      if (
        this.peerConnection.connectionState === "disconnected" ||
        this.peerConnection.connectionState === "failed" ||
        this.peerConnection.connectionState === "closed"
      ) {
        this.closeCall();
      }
    };
  }

  /**
   * Wait until ICE gathering is complete or the timeout elapses.
   * Resolving on timeout ensures the call still proceeds even on restrictive networks.
   *
   * @param {number} timeout - Maximum ms to wait (default 6000)
   * @returns {Promise<void>}
   */
  waitForIceGathering(timeout = 10000) {
    return new Promise((resolve) => {
      if (
        !this.peerConnection ||
        this.peerConnection.iceGatheringState === "complete"
      ) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        this.peerConnection?.removeEventListener(
          "icegatheringstatechange",
          onStateChange,
        );
        console.warn("[WebRTC] ICE gathering timed out — proceeding with partial candidates");
        resolve();
      }, timeout);

      const onStateChange = () => {
        if (this.peerConnection?.iceGatheringState === "complete") {
          clearTimeout(timer);
          this.peerConnection.removeEventListener(
            "icegatheringstatechange",
            onStateChange,
          );
          resolve();
        }
      };

      this.peerConnection.addEventListener(
        "icegatheringstatechange",
        onStateChange,
      );
    });
  }

  /**
   * Get local media stream
   */
  async getLocalStream(callType) {
    // Prefer portrait capture on phones and landscape on larger screens.
    // NOTE: using only CSS px width can be wrong on mobile browsers that report a
    // large layout viewport (e.g., ~980px). Use multiple signals.
    const isLikelyMobile =
      (navigator.userAgentData && navigator.userAgentData.mobile === true) ||
      (navigator.maxTouchPoints && navigator.maxTouchPoints > 1) ||
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");

    const vw = window.visualViewport?.width || window.innerWidth || 0;
    const vh = window.visualViewport?.height || window.innerHeight || 0;
    const minDim = Math.min(vw, vh);

    const isPhone = isLikelyMobile && minDim <= 700;
    const preferPortrait = isPhone;

    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video:
        callType === "video"
          ? {
              // On phones, request a portrait-ish frame; on desktop, request landscape.
              width: { ideal: preferPortrait ? 720 : 1280 },
              height: { ideal: preferPortrait ? 1280 : 720 },
              // Hint to browsers that support aspectRatio selection.
              aspectRatio: preferPortrait ? 9 / 16 : 16 / 9,
              facingMode: "user",
            }
          : false,
    };

    try {
      this.localStream = await getUserMediaSafe(constraints);
    } catch (err) {
      // Insecure context / not-supported: surface immediately, no fallback possible
      if (
        err.name === "InsecureContextError" ||
        err.name === "NotSupportedError"
      ) {
        throw err;
      }
      // Camera not found on a video call → fall back to audio-only
      if (
        callType === "video" &&
        (err.name === "NotFoundError" || err.name === "NotReadableError")
      ) {
        this.showNotification(
          "Camera unavailable — starting audio call instead",
          "warning",
        );
        this.currentCallType = "audio";
        constraints.video = false;
        this.localStream = await getUserMediaSafe({ audio: constraints.audio });
      } else {
        throw err;
      }
    }

    const localVideo = document.getElementById("local-video");
    if (localVideo) localVideo.srcObject = this.localStream;

    // Hide video elements for audio-only calls
    if (this.currentCallType === "audio" || callType === "audio") {
      const lv = document.getElementById("local-video");
      const rv = document.getElementById("remote-video");
      if (lv) lv.style.display = "none";
      if (rv) rv.style.display = "none";
    }
  }

  /**
   * Toggle audio mute
   */
  toggleAudio() {
    if (!this.localStream) return;

    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const btn = document.getElementById("toggle-audio");
      if (btn) {
        btn.classList.toggle("muted", !audioTrack.enabled);
        btn.querySelector("i").className = audioTrack.enabled
          ? "fas fa-microphone"
          : "fas fa-microphone-slash";
      }
    }
  }

  /**
   * Toggle video on/off
   */
  toggleVideo() {
    if (!this.localStream) return;

    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      const btn = document.getElementById("toggle-video");
      if (btn) {
        btn.classList.toggle("video-off", !videoTrack.enabled);
        btn.querySelector("i").className = videoTrack.enabled
          ? "fas fa-video"
          : "fas fa-video-slash";
      }
    }
  }

  /**
   * End call and notify the remote peer
   */
  endCall() {
    if (this.currentCallId) {
      this.sendCallSignal({
        callId: this.currentCallId,
        signalType: "CALL_END",
      });
    }
    this.closeCall();
  }

  /**
   * Close call and release all resources
   */
  closeCall() {
    this.stopCallTimer();
    this.stopRingtone();
    this.hideCallNotificationModal();

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.remoteStream = null;

    // Reset all state
    this.currentCallId = null;
    this.currentCallType = null;
    this.isCallActive = false;
    this.isCaller = false;
    this.remotePeer = null;
    this.pendingOffer = null;

    this.hideCallOverlay();
  }

  /**
   * Send a call signal over WebSocket.
   * Converts the signalType (e.g. CALL_ICE_CANDIDATE) into a kebab-case endpoint
   * (/app/call-ice-candidate) by stripping the CALL_ prefix and replacing
   * all underscores — including those within compound words — with hyphens.
   */
  sendCallSignal(signal) {
    const endpoint = signal.signalType
      .toLowerCase()
      .replace("call_", "")
      .replace(/_/g, "-");
    this.stompClient.send("/app/call-" + endpoint, {}, JSON.stringify(signal));
  }

  /**
   * Show the call overlay.
   * On the /call page the full-page UI is already visible; we ensure the active
   * call container is shown and the "call ended" screen is hidden.
   * On other pages (e.g. chat) we un-hide the injected #call-overlay element.
   */
  showCallOverlay() {
    if (window.location.pathname === "/call") {
      document.getElementById("call-overlay")?.classList.remove("hidden");
      document.getElementById("call-ended-screen")?.classList.add("hidden");
    } else {
      document.getElementById("call-overlay")?.classList.remove("hidden");
    }
  }

  /**
   * Hide the call overlay.
   * On the /call page, swap to the "call ended" screen.
   * On other pages, hide the injected overlay element.
   */
  hideCallOverlay() {
    if (window.location.pathname === "/call") {
      document.getElementById("call-overlay")?.classList.add("hidden");
      document.getElementById("call-ended-screen")?.classList.remove("hidden");
    } else {
      document.getElementById("call-overlay")?.classList.add("hidden");
    }
  }

  /**
   * Update call status text in any status elements present in the DOM
   */
  updateCallStatus(status) {
    const statusEl = document.getElementById("call-status");
    if (statusEl) statusEl.textContent = status;
    const stateEl = document.getElementById("call-state-text");
    if (stateEl) stateEl.textContent = status;
  }

  /**
   * Start call duration timer.
   * Guard against double-start: if the timer is already running (e.g. the
   * callee's answerIncomingCall started it, then CALL_ACCEPTED arrives and
   * tries to start it again), do nothing.
   */
  startCallTimer() {
    if (this.callTimerInterval) return; // already running
    this.callStartTime = Date.now();
    this.callTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.callStartTime) / 1000);
      const minutes = Math.floor(elapsed / 60)
        .toString()
        .padStart(2, "0");
      const seconds = (elapsed % 60).toString().padStart(2, "0");
      const durationEl = document.getElementById("call-duration");
      if (durationEl) durationEl.textContent = `${minutes}:${seconds}`;
    }, 1000);
  }

  /**
   * Stop call duration timer
   */
  stopCallTimer() {
    if (this.callTimerInterval) {
      clearInterval(this.callTimerInterval);
      this.callTimerInterval = null;
    }
  }

  /**
   * Play ringtone
   */
  playRingtone() {
    this.ringtoneAudio = new Audio("/sounds/ringtone.mp3");
    this.ringtoneAudio.loop = true;
    this.ringtoneAudio
      .play()
      .catch((e) => console.log("Ringtone play failed:", e));
  }

  /**
   * Stop ringtone
   */
  stopRingtone() {
    if (this.ringtoneAudio) {
      this.ringtoneAudio.pause();
      this.ringtoneAudio = null;
    }
  }

  /**
   * Show a visual toast notification (never falls back to alert())
   */
  showNotification(message, type = "info") {
    if (window.showToast) {
      window.showToast(message, type);
      return;
    }
    const toast = document.createElement("div");
    toast.textContent = message;
    let bg;
    if (type === "error") bg = "#e74c3c";
    else if (type === "warning") bg = "#f39c12";
    else bg = "#27ae60";
    toast.style.cssText = `
            position: fixed; top: 24px; right: 24px;
            background: ${bg}; color: #fff;
            padding: 14px 20px; border-radius: 12px;
            font-size: 14px; font-weight: 500; z-index: 99999;
            box-shadow: 0 8px 32px rgba(0,0,0,0.35);
            max-width: 360px;
            font-family: 'Poppins', sans-serif;
            animation: fadeIn 0.25s ease;
        `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s ease";
      setTimeout(() => toast.remove(), 350);
    }, 3500);
  }
}

window.WebRTCCallManager = WebRTCCallManager;
