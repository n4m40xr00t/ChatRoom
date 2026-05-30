package com.chtsys.ChatSystem.config;

import com.chtsys.ChatSystem.Model.CallSession;
import com.chtsys.ChatSystem.Model.CallSignal;
import com.chtsys.ChatSystem.Model.ChatMessage;
import com.chtsys.ChatSystem.Model.Message;
import com.chtsys.ChatSystem.Model.Status;
import com.chtsys.ChatSystem.repository.CallSessionRepository;
import com.chtsys.ChatSystem.repository.ChatMessageRepository;
import com.chtsys.ChatSystem.repository.UserRepository;
import com.chtsys.ChatSystem.Model.UserEntity;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.SimpMessageSendingOperations;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionConnectEvent;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.time.LocalDateTime;
import java.util.List;

@Component
public class WebSocketEventListener {

    private final SimpMessageSendingOperations messagingTemplate;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private CallSessionRepository callSessionRepository;

    @Autowired
    private ChatMessageRepository chatMessageRepository;

    public WebSocketEventListener(SimpMessageSendingOperations messagingTemplate) {
        this.messagingTemplate = messagingTemplate;
    }

    @EventListener
    public void handleWebSocketConnectListener(SessionConnectEvent event) {
        StompHeaderAccessor headerAccessor = StompHeaderAccessor.wrap(event.getMessage());
        String username = (String) headerAccessor.getSessionAttributes().get("username");
        if (username != null) {
            userRepository.findByUsername(username).ifPresent(user -> {
                user.setOnline(true);
                userRepository.save(user);
                if (user.isShowOnlineStatus()) {
                    Message chatMessage = new Message();
                    chatMessage.setSenderName(username);
                    chatMessage.setStatus(Status.JOIN);
                    messagingTemplate.convertAndSend("/chatroom/public", chatMessage);
                }
            });
        }
    }

    @EventListener
    public void handleWebSocketDisconnectListener(SessionDisconnectEvent event) {
        StompHeaderAccessor headerAccessor = StompHeaderAccessor.wrap(event.getMessage());
        String username = (String) headerAccessor.getSessionAttributes().get("username");
        if (username != null) {
            // Mark user offline
            userRepository.findByUsername(username).ifPresent(user -> {
                user.setOnline(false);
                user.setLastSeenAt(LocalDateTime.now());
                userRepository.save(user);
            });

            // End ACTIVE call sessions on disconnect (handles crash / force-close).
            //
            // ⚠  Do NOT touch sessions in "ringing" state here.
            //    When a callee taps Accept, their chat-page WebSocket disconnects
            //    as the browser navigates to /call.  If we end the session at that
            //    moment the caller immediately receives CALL_ENDED and sees
            //    "Call Ended" before the call even connects.
            //    Stale ringing sessions (nobody answered) are cleaned up after
            //    60 s by CallTimeoutScheduler.
            List<CallSession> activeCalls = callSessionRepository.findActiveCallsForUser(username);
            for (CallSession session : activeCalls) {

                // Skip ringing sessions — see note above.
                if ("ringing".equals(session.getStatus())) {
                    continue;
                }

                String otherParty = session.getCaller().equals(username)
                        ? session.getCallee()
                        : session.getCaller();

                session.setStatus("ended");
                session.setEndedAt(LocalDateTime.now());
                session.setEndedBy(username);
                session.setEndReason("disconnect");
                Long duration = null;
                if (session.getAnsweredAt() != null) {
                    long secs = java.time.temporal.ChronoUnit.SECONDS
                            .between(session.getAnsweredAt(), LocalDateTime.now());
                    session.setDurationSeconds(secs);
                    duration = secs;
                }
                callSessionRepository.save(session);

                // Create call log message
                String logStatus = session.getAnsweredAt() != null ? "answered" : "missed";
                String callType = session.getCallType() != null ? session.getCallType() : "video";
                String json = "{\"callType\":\"" + callType + "\",\"status\":\"" + logStatus + "\"";
                if (duration != null) json += ",\"durationSeconds\":" + duration;
                json += "}";
                ChatMessage callLog = new ChatMessage();
                callLog.setSenderName(session.getCaller());
                callLog.setReceiverName(session.getCallee());
                callLog.setContent(json);
                callLog.setMessageType("CALL_LOG");
                callLog.setTimestamp(LocalDateTime.now());
                callLog.setStatus(Status.MESSAGE);
                callLog.setPublic(false);
                chatMessageRepository.save(callLog);
                Message outbound = new Message();
                outbound.setId(callLog.getId());
                outbound.setSenderName(session.getCaller());
                outbound.setReceiverName(session.getCallee());
                outbound.setMessage(json);
                outbound.setMessageType("CALL_LOG");
                outbound.setStatus(Status.MESSAGE);
                messagingTemplate.convertAndSendToUser(session.getCaller(), "/private", outbound);
                messagingTemplate.convertAndSendToUser(session.getCallee(), "/private", outbound);

                // Notify the other party so their UI transitions to the ended screen
                CallSignal ended = new CallSignal();
                ended.setCallId(session.getCallId());
                ended.setCaller(session.getCaller());
                ended.setCallee(session.getCallee());
                ended.setCallType(session.getCallType());
                ended.setSignalType(Status.CALL_ENDED);
                ended.setTimestamp(LocalDateTime.now().toString());
                messagingTemplate.convertAndSendToUser(otherParty, "/call", ended);
            }

            // Broadcast presence change (only if user has online status visible)
            userRepository.findByUsername(username).ifPresent(user -> {
                if (user.isShowOnlineStatus()) {
                    Message chatMessage = new Message();
                    chatMessage.setSenderName(username);
                    chatMessage.setStatus(Status.LEAVE);
                    messagingTemplate.convertAndSend("/chatroom/public", chatMessage);
                }
            });
        }
    }
}
