package com.chtsys.ChatSystem.service;

import com.chtsys.ChatSystem.Model.*;
import com.chtsys.ChatSystem.repository.ChatMessageRepository;
import com.chtsys.ChatSystem.repository.ContactRepository;
import com.chtsys.ChatSystem.repository.ScheduledMessageRepository;
import com.chtsys.ChatSystem.repository.UserBlockRepository;
import com.chtsys.ChatSystem.repository.UserRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;

@Service
public class ScheduledMessageService {

    @Autowired
    private ScheduledMessageRepository scheduledMessageRepository;

    @Autowired
    private ChatMessageRepository chatMessageRepository;

    @Autowired
    private ContactRepository contactRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private UserBlockRepository userBlockRepository;

    @Autowired
    private SimpMessagingTemplate simpMessagingTemplate;

    @Scheduled(fixedDelay = 30000) // Run every 30 seconds
    public void sendScheduledMessages() {
        List<ScheduledMessage> due = scheduledMessageRepository.findByScheduledAtBeforeAndSentFalse(LocalDateTime.now());

        for (ScheduledMessage sm : due) {
            try {
                // Check sender and receiver status before delivering
                UserEntity senderEntity = userRepository.findByUsername(sm.getSenderName()).orElse(null);
                UserEntity receiverEntity = userRepository.findByUsername(sm.getReceiverName()).orElse(null);

                // Skip if sender or receiver no longer exists
                if (senderEntity == null || receiverEntity == null) {
                    sm.setSent(true);
                    scheduledMessageRepository.save(sm);
                    continue;
                }

                // Skip if sender is banned
                if (senderEntity.isBanned()) {
                    sm.setSent(true);
                    scheduledMessageRepository.save(sm);
                    continue;
                }

                // Skip if either user has blocked the other
                if (userBlockRepository.existsByBlockerAndBlocked(senderEntity, receiverEntity)
                        || userBlockRepository.existsByBlockerAndBlocked(receiverEntity, senderEntity)) {
                    sm.setSent(true);
                    scheduledMessageRepository.save(sm);
                    continue;
                }

                // Save to ChatMessage
                ChatMessage chatMsg = new ChatMessage();
                chatMsg.setSenderName(sm.getSenderName());
                chatMsg.setReceiverName(sm.getReceiverName());
                chatMsg.setContent(sm.getContent());
                chatMsg.setTimestamp(LocalDateTime.now());
                chatMsg.setStatus(Status.MESSAGE);
                chatMsg.setPublic(false);
                chatMsg.setMessageType(sm.getMessageType() != null ? sm.getMessageType() : "TEXT");
                if (sm.getReplyToId() != null) {
                    chatMsg.setReplyToId(sm.getReplyToId());
                    chatMsg.setReplyToContent(sm.getReplyToContent());
                    chatMsg.setReplyToSender(sm.getReplyToSender());
                }
                chatMessageRepository.save(chatMsg);

                // Auto-add contacts if not already connected
                if (!contactRepository.existsByOwnerAndContactUser(senderEntity, receiverEntity)) {
                    Contact c1 = new Contact();
                    c1.setOwner(senderEntity);
                    c1.setContactUser(receiverEntity);
                    contactRepository.save(c1);
                }
                if (!contactRepository.existsByOwnerAndContactUser(receiverEntity, senderEntity)) {
                    Contact c2 = new Contact();
                    c2.setOwner(receiverEntity);
                    c2.setContactUser(senderEntity);
                    contactRepository.save(c2);
                }

                // Build STOMP message
                Message msg = new Message();
                msg.setId(chatMsg.getId());
                msg.setSenderName(sm.getSenderName());
                msg.setReceiverName(sm.getReceiverName());
                msg.setMessage(sm.getContent());
                msg.setStatus(Status.MESSAGE);
                msg.setMessageType(sm.getMessageType());
                msg.setReplyToId(sm.getReplyToId());
                msg.setReplyToContent(sm.getReplyToContent());
                msg.setReplyToSender(sm.getReplyToSender());

                // Deliver via WebSocket
                simpMessagingTemplate.convertAndSendToUser(sm.getReceiverName(), "/private", msg);
                simpMessagingTemplate.convertAndSendToUser(sm.getSenderName(), "/private", msg);

                // Mark as sent
                sm.setSent(true);
                scheduledMessageRepository.save(sm);

            } catch (Exception e) {
                // Log failure but don't crash the scheduler
                System.err.println("Failed to send scheduled message id=" + sm.getId() + ": " + e.getMessage());
            }
        }
    }
}
