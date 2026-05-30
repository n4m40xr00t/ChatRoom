package com.chtsys.ChatSystem.controller;

import com.chtsys.ChatSystem.Model.*;
import com.chtsys.ChatSystem.repository.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Controller;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/**
 * WebRTC Call Controller
 *
 * Handles peer-to-peer video and audio call signaling via WebSocket/STOMP.
 * Acts as a signaling server to exchange SDP offers/answers and ICE candidates
 * between peers for WebRTC connection establishment.
 *
 * Security features:
 * - Validates user authentication via session
 * - Checks for blocked users
 * - Prevents concurrent calls (busy detection)
 * - Validates call permissions
 * - Tracks call sessions for audit and history
 */
@Controller
@Transactional
public class CallController {

    @Autowired
    private SimpMessagingTemplate messagingTemplate;

    @Autowired
    private CallSessionRepository callSessionRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private UserBlockRepository userBlockRepository;

    @Autowired
    private GroupMemberRepository groupMemberRepository;

    @Autowired
    private ChatMessageRepository chatMessageRepository;

    /** Call timeout in seconds (if not answered) */
    private static final int CALL_TIMEOUT_SECONDS = 60;

    /**
     * Send a system notification to a user
     */
    private void sendCallNotification(String username, String message, Status status) {
        CallSignal notification = new CallSignal();
        notification.setCaller("System");
        notification.setCallee(username);
        notification.setSignalType(status);
        notification.setErrorMessage(message);
        notification.setTimestamp(LocalDateTime.now().toString());
        messagingTemplate.convertAndSendToUser(username, "/call", notification);
    }

    /**
     * Check if two users have blocked each other
     */
    private boolean isBlockedBetween(UserEntity user1, UserEntity user2) {
        if (user1 == null || user2 == null) return true;
        return userBlockRepository.existsByBlockerAndBlocked(user1, user2)
                || userBlockRepository.existsByBlockerAndBlocked(user2, user1);
    }

    /**
     * Create a call log ChatMessage and push it via STOMP to both parties.
     */
    private void createCallLogMessage(String caller, String callee, String callType, String logStatus, Long durationSeconds, LocalDateTime timestamp) {
        if (caller == null || callee == null) return;
        String safeType = callType != null ? callType : "video";
        StringBuilder json = new StringBuilder();
        json.append("{\"callType\":\"").append(safeType).append("\",\"status\":\"").append(logStatus).append("\"");
        if (durationSeconds != null) {
            json.append(",\"durationSeconds\":").append(durationSeconds);
        }
        json.append("}");

        LocalDateTime now = timestamp != null ? timestamp : LocalDateTime.now();

        ChatMessage chatMsg = new ChatMessage();
        chatMsg.setSenderName(caller);
        chatMsg.setReceiverName(callee);
        chatMsg.setContent(json.toString());
        chatMsg.setMessageType("CALL_LOG");
        chatMsg.setTimestamp(now);
        chatMsg.setStatus(Status.MESSAGE);
        chatMsg.setPublic(false);
        chatMessageRepository.save(chatMsg);

        Message outbound = new Message();
        outbound.setId(chatMsg.getId());
        outbound.setSenderName(caller);
        outbound.setReceiverName(callee);
        outbound.setMessage(json.toString());
        outbound.setMessageType("CALL_LOG");
        outbound.setStatus(Status.MESSAGE);

        messagingTemplate.convertAndSendToUser(caller, "/private", outbound);
        messagingTemplate.convertAndSendToUser(callee, "/private", outbound);
    }

    /**
     * Immediate ring notification — called from the caller's CHAT PAGE WebSocket.
     * Validates the call, creates the session, and notifies the callee instantly.
     * No SDP is needed here; the call window sends the SDP offer separately via /call-offer.
     */
    @MessageMapping("/call-ring")
    public void handleCallRing(@Payload CallSignal signal, StompHeaderAccessor accessor) {
        String caller = (String) accessor.getSessionAttributes().get("username");
        if (caller == null || signal.getCallee() == null) return;

        UserEntity callerEntity = userRepository.findByUsername(caller).orElse(null);
        if (callerEntity == null || callerEntity.isBanned()) {
            sendCallNotification(caller, "You cannot make calls.", Status.CALL_ERROR);
            return;
        }

        UserEntity calleeEntity = userRepository.findByUsername(signal.getCallee()).orElse(null);
        if (calleeEntity == null) {
            sendCallNotification(caller, "User not found.", Status.CALL_UNAVAILABLE);
            return;
        }

        if (isBlockedBetween(callerEntity, calleeEntity)) {
            sendCallNotification(caller, "Cannot call this user.", Status.CALL_ERROR);
            return;
        }

        if (!calleeEntity.isOnline()) {
            sendCallNotification(caller, signal.getCallee() + " is offline.", Status.CALL_UNAVAILABLE);
            createCallLogMessage(caller, signal.getCallee(), signal.getCallType(), "missed", null, LocalDateTime.now());
            return;
        }

        if (callSessionRepository.isUserInActiveCall(caller)) {
            sendCallNotification(caller, "You are already in a call.", Status.CALL_ERROR);
            return;
        }

        if (callSessionRepository.isUserInActiveCall(signal.getCallee())) {
            sendCallNotification(caller, signal.getCallee() + " is busy.", Status.CALL_BUSY);
            createCallLogMessage(caller, signal.getCallee(), signal.getCallType(), "missed", null, LocalDateTime.now());
            return;
        }

        String callId = UUID.randomUUID().toString();
        CallSession session = CallSession.builder()
                .callId(callId)
                .caller(caller)
                .callee(signal.getCallee())
                .callType(signal.getCallType() != null ? signal.getCallType() : "video")
                .status("ringing")
                .startedAt(LocalDateTime.now())
                .build();
        callSessionRepository.save(session);

        // Notify callee immediately (no SDP — the call window sends SDP separately)
        CallSignal notification = new CallSignal();
        notification.setCallId(callId);
        notification.setCaller(caller);
        notification.setCallee(signal.getCallee());
        notification.setCallType(signal.getCallType());
        notification.setSignalType(Status.CALL_OFFER);
        notification.setTimestamp(LocalDateTime.now().toString());
        messagingTemplate.convertAndSendToUser(signal.getCallee(), "/call", notification);

        // Return callId to the caller's chat page so it can pass it to the call window
        CallSignal ringing = new CallSignal();
        ringing.setCallId(callId);
        ringing.setCaller(caller);
        ringing.setCallee(signal.getCallee());
        ringing.setCallType(signal.getCallType());
        ringing.setSignalType(Status.CALL_RINGING);
        ringing.setTimestamp(LocalDateTime.now().toString());
        messagingTemplate.convertAndSendToUser(caller, "/call", ringing);
    }

    /**
     * Initiate a call with SDP offer
     *
     * Flow:
     * 1. Caller sends CALL_OFFER with SDP
     * 2. Server validates permissions and availability
     * 3. Server creates call session
     * 4. Server forwards offer to callee
     * 5. Callee receives offer and can accept/reject
     */
    @MessageMapping("/call-offer")
    public void handleCallOffer(@Payload CallSignal signal, StompHeaderAccessor accessor) {
        String caller = (String) accessor.getSessionAttributes().get("username");
        if (caller == null || signal.getCallee() == null) {
            return;
        }

        // Fast path: call window is providing SDP for a session pre-established by /call-ring.
        // All validation already happened there; just forward the SDP to the callee.
        if (signal.getCallId() != null && !signal.getCallId().isBlank()) {
            CallSession existing = callSessionRepository.findByCallId(signal.getCallId()).orElse(null);
            if (existing != null && existing.getCaller().equals(caller)
                    && "ringing".equals(existing.getStatus())) {
                CallSignal offerWithSdp = new CallSignal();
                offerWithSdp.setCallId(existing.getCallId());
                offerWithSdp.setCaller(caller);
                offerWithSdp.setCallee(existing.getCallee());
                offerWithSdp.setCallType(existing.getCallType());
                offerWithSdp.setSignalType(Status.CALL_OFFER);
                offerWithSdp.setSdp(signal.getSdp());
                offerWithSdp.setTimestamp(LocalDateTime.now().toString());
                messagingTemplate.convertAndSendToUser(existing.getCallee(), "/call", offerWithSdp);
                return;
            }
        }

        // Validate caller
        UserEntity callerEntity = userRepository.findByUsername(caller).orElse(null);
        if (callerEntity == null || callerEntity.isBanned()) {
            sendCallNotification(caller, "You cannot make calls.", Status.CALL_ERROR);
            return;
        }

        // Validate callee
        UserEntity calleeEntity = userRepository.findByUsername(signal.getCallee()).orElse(null);
        if (calleeEntity == null) {
            sendCallNotification(caller, "User not found.", Status.CALL_UNAVAILABLE);
            return;
        }

        // Check if users are blocked
        if (isBlockedBetween(callerEntity, calleeEntity)) {
            sendCallNotification(caller, "Cannot call this user.", Status.CALL_ERROR);
            return;
        }

        // Check if callee is online
        if (!calleeEntity.isOnline()) {
            sendCallNotification(caller, signal.getCallee() + " is offline.", Status.CALL_UNAVAILABLE);
            createCallLogMessage(caller, signal.getCallee(), signal.getCallType(), "missed", null, LocalDateTime.now());
            return;
        }

        // Check if caller is already in a call
        if (callSessionRepository.isUserInActiveCall(caller)) {
            sendCallNotification(caller, "You are already in a call.", Status.CALL_ERROR);
            return;
        }

        // Check if callee is already in a call
        if (callSessionRepository.isUserInActiveCall(signal.getCallee())) {
            sendCallNotification(caller, signal.getCallee() + " is busy.", Status.CALL_BUSY);
            createCallLogMessage(caller, signal.getCallee(), signal.getCallType(), "missed", null, LocalDateTime.now());
            return;
        }

        // Generate unique call ID
        String callId = UUID.randomUUID().toString();

        // Create call session
        CallSession session = CallSession.builder()
                .callId(callId)
                .caller(caller)
                .callee(signal.getCallee())
                .callType(signal.getCallType() != null ? signal.getCallType() : "video")
                .status("ringing")
                .startedAt(LocalDateTime.now())
                .build();
        callSessionRepository.save(session);

        // Prepare offer signal
        CallSignal offer = new CallSignal();
        offer.setCallId(callId);
        offer.setCaller(caller);
        offer.setCallee(signal.getCallee());
        offer.setCallType(signal.getCallType());
        offer.setSignalType(Status.CALL_OFFER);
        offer.setSdp(signal.getSdp());
        offer.setTimestamp(LocalDateTime.now().toString());

        // Send offer to callee
        messagingTemplate.convertAndSendToUser(signal.getCallee(), "/call", offer);

        // Send ringing confirmation to caller
        CallSignal ringing = new CallSignal();
        ringing.setCallId(callId);
        ringing.setCaller(caller);
        ringing.setCallee(signal.getCallee());
        ringing.setCallType(signal.getCallType());
        ringing.setSignalType(Status.CALL_RINGING);
        ringing.setTimestamp(LocalDateTime.now().toString());
        messagingTemplate.convertAndSendToUser(caller, "/call", ringing);
    }

    /**
     * Answer a call with SDP answer
     *
     * Flow:
     * 1. Callee sends CALL_ANSWER with SDP
     * 2. Server validates call session
     * 3. Server updates session status to 'active'
     * 4. Server forwards answer to caller
     * 5. WebRTC connection is established
     */
    @MessageMapping("/call-answer")
    public void handleCallAnswer(@Payload CallSignal signal, StompHeaderAccessor accessor) {
        String callee = (String) accessor.getSessionAttributes().get("username");
        if (callee == null || signal.getCallId() == null) {
            return;
        }

        // Find call session
        CallSession session = callSessionRepository.findByCallId(signal.getCallId()).orElse(null);
        if (session == null || !session.getCallee().equals(callee)) {
            sendCallNotification(callee, "Invalid call session.", Status.CALL_ERROR);
            return;
        }

        // Update session status
        session.setStatus("active");
        session.setAnsweredAt(LocalDateTime.now());
        callSessionRepository.save(session);

        // Prepare answer signal
        CallSignal answer = new CallSignal();
        answer.setCallId(signal.getCallId());
        answer.setCaller(session.getCaller());
        answer.setCallee(callee);
        answer.setCallType(session.getCallType());
        answer.setSignalType(Status.CALL_ANSWER);
        answer.setSdp(signal.getSdp());
        answer.setTimestamp(LocalDateTime.now().toString());

        // Send answer to caller
        messagingTemplate.convertAndSendToUser(session.getCaller(), "/call", answer);

        // Send accepted confirmation to callee
        CallSignal accepted = new CallSignal();
        accepted.setCallId(signal.getCallId());
        accepted.setCaller(session.getCaller());
        accepted.setCallee(callee);
        accepted.setCallType(session.getCallType());
        accepted.setSignalType(Status.CALL_ACCEPTED);
        accepted.setTimestamp(LocalDateTime.now().toString());
        messagingTemplate.convertAndSendToUser(callee, "/call", accepted);
    }

    /**
     * Exchange ICE candidates for NAT traversal
     *
     * ICE candidates are exchanged continuously during call setup
     * to establish the best possible peer-to-peer connection path.
     */
    @MessageMapping("/call-ice-candidate")
    public void handleIceCandidate(@Payload CallSignal signal, StompHeaderAccessor accessor) {
        String sender = (String) accessor.getSessionAttributes().get("username");
        if (sender == null || signal.getCallId() == null) {
            return;
        }

        // Find call session
        CallSession session = callSessionRepository.findByCallId(signal.getCallId()).orElse(null);
        if (session == null) {
            return;
        }

        // Determine recipient (the other peer)
        String recipient = session.getCaller().equals(sender) ? session.getCallee() : session.getCaller();

        // Forward ICE candidate to the other peer
        CallSignal iceSignal = new CallSignal();
        iceSignal.setCallId(signal.getCallId());
        iceSignal.setCaller(session.getCaller());
        iceSignal.setCallee(session.getCallee());
        iceSignal.setSignalType(Status.CALL_ICE_CANDIDATE);
        iceSignal.setIceCandidate(signal.getIceCandidate());
        iceSignal.setTimestamp(LocalDateTime.now().toString());

        messagingTemplate.convertAndSendToUser(recipient, "/call", iceSignal);
    }

    /**
     * Reject an incoming call
     */
    @MessageMapping("/call-reject")
    public void handleCallReject(@Payload CallSignal signal, StompHeaderAccessor accessor) {
        String callee = (String) accessor.getSessionAttributes().get("username");
        if (callee == null || signal.getCallId() == null) {
            return;
        }

        // Find call session
        CallSession session = callSessionRepository.findByCallId(signal.getCallId()).orElse(null);
        if (session == null || !session.getCallee().equals(callee)) {
            return;
        }

        // Update session
        session.setStatus("rejected");
        session.setEndedAt(LocalDateTime.now());
        session.setEndedBy(callee);
        session.setEndReason("rejected");
        callSessionRepository.save(session);

        createCallLogMessage(session.getCaller(), session.getCallee(), session.getCallType(), "missed", null, session.getEndedAt());

        // Notify caller
        CallSignal rejected = new CallSignal();
        rejected.setCallId(signal.getCallId());
        rejected.setCaller(session.getCaller());
        rejected.setCallee(callee);
        rejected.setCallType(session.getCallType());
        rejected.setSignalType(Status.CALL_REJECTED);
        rejected.setTimestamp(LocalDateTime.now().toString());

        messagingTemplate.convertAndSendToUser(session.getCaller(), "/call", rejected);
    }

    /**
     * End an active call
     *
     * Either peer can end the call at any time.
     */
    @MessageMapping("/call-end")
    public void handleCallEnd(@Payload CallSignal signal, StompHeaderAccessor accessor) {
        String sender = (String) accessor.getSessionAttributes().get("username");
        if (sender == null || signal.getCallId() == null) {
            return;
        }

        // Find call session
        CallSession session = callSessionRepository.findByCallId(signal.getCallId()).orElse(null);
        if (session == null) {
            return;
        }

        // Verify sender is part of the call
        if (!session.getCaller().equals(sender) && !session.getCallee().equals(sender)) {
            return;
        }

        // Calculate duration if call was active
        Long duration = null;
        if (session.getAnsweredAt() != null) {
            duration = ChronoUnit.SECONDS.between(session.getAnsweredAt(), LocalDateTime.now());
        }

        // Update session
        session.setStatus("ended");
        session.setEndedAt(LocalDateTime.now());
        session.setEndedBy(sender);
        session.setEndReason("normal");
        session.setDurationSeconds(duration);
        callSessionRepository.save(session);

        createCallLogMessage(session.getCaller(), session.getCallee(), session.getCallType(), "answered", duration, session.getEndedAt());

        // Determine recipient
        String recipient = session.getCaller().equals(sender) ? session.getCallee() : session.getCaller();

        // Notify both parties
        CallSignal ended = new CallSignal();
        ended.setCallId(signal.getCallId());
        ended.setCaller(session.getCaller());
        ended.setCallee(session.getCallee());
        ended.setCallType(session.getCallType());
        ended.setSignalType(Status.CALL_ENDED);
        ended.setTimestamp(LocalDateTime.now().toString());

        messagingTemplate.convertAndSendToUser(recipient, "/call", ended);
        messagingTemplate.convertAndSendToUser(sender, "/call", ended);
    }

    /**
     * Scheduled task to timeout ringing calls
     * Should be called periodically (e.g., every 10 seconds)
     */
    public void timeoutRingingCalls() {
        LocalDateTime cutoff = LocalDateTime.now().minusSeconds(CALL_TIMEOUT_SECONDS);
        var timedOutCalls = callSessionRepository.findTimedOutRingingCalls(cutoff);

        for (CallSession session : timedOutCalls) {
            // Update session
            session.setStatus("timeout");
            session.setEndedAt(LocalDateTime.now());
            session.setEndReason("timeout");
            callSessionRepository.save(session);

            createCallLogMessage(session.getCaller(), session.getCallee(), session.getCallType(), "missed", null, session.getEndedAt());

            // Notify both parties
            CallSignal timeout = new CallSignal();
            timeout.setCallId(session.getCallId());
            timeout.setCaller(session.getCaller());
            timeout.setCallee(session.getCallee());
            timeout.setCallType(session.getCallType());
            timeout.setSignalType(Status.CALL_TIMEOUT);
            timeout.setTimestamp(LocalDateTime.now().toString());

            messagingTemplate.convertAndSendToUser(session.getCaller(), "/call", timeout);
            messagingTemplate.convertAndSendToUser(session.getCallee(), "/call", timeout);
        }
    }
}
