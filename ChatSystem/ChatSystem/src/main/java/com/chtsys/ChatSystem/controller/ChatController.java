package com.chtsys.ChatSystem.controller;

import com.chtsys.ChatSystem.Model.*;
import com.chtsys.ChatSystem.repository.ChatGroupRepository;
import com.chtsys.ChatSystem.repository.ChatMessageRepository;
import com.chtsys.ChatSystem.repository.ContactRepository;
import com.chtsys.ChatSystem.repository.GroupMemberRepository;
import com.chtsys.ChatSystem.repository.MessageReadReceiptRepository;
import com.chtsys.ChatSystem.repository.ScheduledMessageRepository;
import com.chtsys.ChatSystem.repository.UserBlockRepository;
import com.chtsys.ChatSystem.repository.UserRepository;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.handler.annotation.SendTo;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Controller;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

@Controller
@Transactional
public class ChatController {

    private String escapeHtml(String input) {
        if (input == null) return null;
        return input
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#x27;");
    }

    @Autowired
    private SimpMessagingTemplate simpMessagingTemplate;

    @Autowired
    private ChatMessageRepository chatMessageRepository;

    @Autowired
    private ContactRepository contactRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private UserBlockRepository userBlockRepository;

    @Autowired
    private ScheduledMessageRepository scheduledMessageRepository;

    @Autowired
    private ChatGroupRepository chatGroupRepository;

    @Autowired
    private GroupMemberRepository groupMemberRepository;

    @Autowired
    private MessageReadReceiptRepository messageReadReceiptRepository;

    @Value("${app.max-message-length:10000}")
    private int maxMessageLength;

    @Value("${app.max-image-bytes:5242880}")
    private int maxImageBytes;

    private void fanoutGroupPrivate(Long groupId, Message outbound) {
        outbound.setGroupId(groupId);
        for (GroupMember member : groupMemberRepository.findByChatGroup_Id(groupId)) {
            simpMessagingTemplate.convertAndSendToUser(member.getUsername(), "/private", outbound);
        }
    }

    private boolean isBlockedBetween(UserEntity sender, UserEntity receiver) {
        if (sender == null || receiver == null) return true;
        return userBlockRepository.existsByBlockerAndBlocked(sender, receiver)
                || userBlockRepository.existsByBlockerAndBlocked(receiver, sender);
    }

    private void sendSystemNotice(String username, String text) {
        Message err = new Message();
        err.setSenderName("System");
        err.setMessage(text);
        err.setStatus(Status.MESSAGE);
        simpMessagingTemplate.convertAndSendToUser(username, "/private", err);
    }

    @MessageMapping("/addUser")
    @SendTo("/chatroom/public")
    public Message addUser(@Payload Message message, StompHeaderAccessor headerAccessor) {
        String authUser = (String) headerAccessor.getSessionAttributes().get("username");
        if (authUser == null) return null;
        message.setSenderName(authUser);
        return message;
    }

    @MessageMapping("/message")
    @SendTo("/chatroom/public")
    public Message receivePublicMessage(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (authUser == null) return null;
        message.setSenderName(authUser);

        // Ban check
        UserEntity sender = userRepository.findByUsername(authUser).orElse(null);
        if (sender != null && sender.isBanned()) {
            sendSystemNotice(authUser, "You are banned and cannot send messages.");
            return null;
        }

        // Size check
        String content = message.getMessage();
        if (content != null) {
            if ("TEXT".equals(message.getMessageType()) || message.getMessageType() == null) {
                if (content.length() > maxMessageLength) {
                    sendSystemNotice(authUser, "Mesaj çox uzundur (maksimum " + maxMessageLength + " simvol).");
                    return null;
                }
            } else if (!"FILE".equals(message.getMessageType())) {
                if (content.length() > maxImageBytes) {
                    sendSystemNotice(authUser, "Fayl çox böyükdür (maksimum 5MB).");
                    return null;
                }
            }
        }

        ChatMessage chatMsg = new ChatMessage();
        chatMsg.setSenderName(authUser);
        chatMsg.setContent(escapeHtml(message.getMessage()));
        chatMsg.setTimestamp(LocalDateTime.now());
        chatMsg.setStatus(message.getStatus());
        chatMsg.setPublic(true);
        chatMsg.setMessageType(message.getMessageType() != null ? message.getMessageType() : "TEXT");
        // File metadata
        if ("FILE".equals(message.getMessageType())) {
            chatMsg.setFileName(message.getFileName());
            chatMsg.setFileSize(message.getFileSize());
            chatMsg.setMimeType(message.getMimeType());
        }
        // Reply fields
        if (message.getReplyToId() != null) {
            chatMsg.setReplyToId(message.getReplyToId());
            chatMsg.setReplyToContent(message.getReplyToContent());
            chatMsg.setReplyToSender(message.getReplyToSender());
            // Inherit thread root from the replied-to message
            ChatMessage parent = chatMessageRepository.findById(message.getReplyToId()).orElse(null);
            if (parent != null) {
                chatMsg.setThreadRootId(parent.getThreadRootId() != null ? parent.getThreadRootId() : parent.getId());
            }
        }
        chatMessageRepository.save(chatMsg);
        
        message.setId(chatMsg.getId());

        return message;
    }

    @MessageMapping("/private-message")
    public Message receivePrivateMessage(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (authUser == null || message.getReceiverName() == null) return null;
        message.setSenderName(authUser);

        // Ban check
        UserEntity sender = userRepository.findByUsername(authUser).orElse(null);
        if (sender != null && sender.isBanned()) {
            sendSystemNotice(authUser, "You are banned and cannot send messages.");
            return null;
        }

        // Size check
        String content = message.getMessage();
        if (content != null) {
            if ("TEXT".equals(message.getMessageType()) || message.getMessageType() == null) {
                if (content.length() > maxMessageLength) {
                    sendSystemNotice(authUser, "Mesaj çox uzundur (maksimum " + maxMessageLength + " simvol).");
                    return null;
                }
            } else if (!"FILE".equals(message.getMessageType())) {
                if (content.length() > maxImageBytes) {
                    sendSystemNotice(authUser, "Fayl çox böyükdür (maksimum 5MB).");
                    return null;
                }
            }
        }

        UserEntity receiverEntity = userRepository.findByUsername(message.getReceiverName()).orElse(null);
        if (receiverEntity == null) return null;
        if (isBlockedBetween(sender, receiverEntity)) {
            sendSystemNotice(authUser, "This private chat is blocked.");
            return null;
        }

        // Save to DB
        ChatMessage chatMsg = new ChatMessage();
        chatMsg.setSenderName(authUser);
        chatMsg.setReceiverName(message.getReceiverName());
        chatMsg.setContent(escapeHtml(message.getMessage()));
        chatMsg.setTimestamp(LocalDateTime.now());
        chatMsg.setStatus(message.getStatus());
        chatMsg.setPublic(false);
        chatMsg.setMessageType(message.getMessageType() != null ? message.getMessageType() : "TEXT");
        // File metadata
        if ("FILE".equals(message.getMessageType())) {
            chatMsg.setFileName(message.getFileName());
            chatMsg.setFileSize(message.getFileSize());
            chatMsg.setMimeType(message.getMimeType());
        }
        // Reply fields
        if (message.getReplyToId() != null) {
            chatMsg.setReplyToId(message.getReplyToId());
            chatMsg.setReplyToContent(message.getReplyToContent());
            chatMsg.setReplyToSender(message.getReplyToSender());
            ChatMessage parent = chatMessageRepository.findById(message.getReplyToId()).orElse(null);
            if (parent != null) {
                chatMsg.setThreadRootId(parent.getThreadRootId() != null ? parent.getThreadRootId() : parent.getId());
            }
        }
        chatMessageRepository.save(chatMsg);

        // Auto-add each other as contacts
        if (sender != null) {
            if (!contactRepository.existsByOwnerAndContactUser(sender, receiverEntity)) {
                Contact c1 = new Contact();
                c1.setOwner(sender);
                c1.setContactUser(receiverEntity);
                contactRepository.save(c1);
            }
            if (!contactRepository.existsByOwnerAndContactUser(receiverEntity, sender)) {
                Contact c2 = new Contact();
                c2.setOwner(receiverEntity);
                c2.setContactUser(sender);
                contactRepository.save(c2);
            }
        }

        message.setId(chatMsg.getId());

        simpMessagingTemplate.convertAndSendToUser(message.getReceiverName(), "/private", message);
        simpMessagingTemplate.convertAndSendToUser(authUser, "/private", message);
        return message;
    }

    @MessageMapping("/group-message")
    public Message receiveGroupMessage(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (authUser == null || message.getGroupId() == null) return null;

        ChatGroup chatGroup = chatGroupRepository.findById(message.getGroupId()).orElse(null);
        if (chatGroup == null) return null;
        if (!groupMemberRepository.existsByChatGroup_IdAndUsername(chatGroup.getId(), authUser)) return null;

        UserEntity sender = userRepository.findByUsername(authUser).orElse(null);
        if (sender != null && sender.isBanned()) {
            sendSystemNotice(authUser, "You are banned and cannot send messages.");
            return null;
        }

        // Size check
        String content = message.getMessage();
        if (content != null) {
            if ("TEXT".equals(message.getMessageType()) || message.getMessageType() == null) {
                if (content.length() > maxMessageLength) {
                    sendSystemNotice(authUser, "Mesaj çox uzundur (maksimum " + maxMessageLength + " simvol).");
                    return null;
                }
            } else if (!"FILE".equals(message.getMessageType())) {
                if (content.length() > maxImageBytes) {
                    sendSystemNotice(authUser, "Fayl çox böyükdür (maksimum 5MB).");
                    return null;
                }
            }
        }

        String type = message.getMessageType() != null ? message.getMessageType() : "TEXT";
        if ("AUDIO".equals(type)) {
            sendSystemNotice(authUser, "Voice messages are not available in groups yet.");
            return null;
        }

        ChatMessage chatMsg = new ChatMessage();
        chatMsg.setSenderName(authUser);
        chatMsg.setContent(escapeHtml(message.getMessage()));
        chatMsg.setTimestamp(LocalDateTime.now());
        chatMsg.setStatus(message.getStatus());
        chatMsg.setPublic(false);
        chatMsg.setMessageType(type);
        chatMsg.setGroup(chatGroup);
        // File metadata
        if ("FILE".equals(type)) {
            chatMsg.setFileName(message.getFileName());
            chatMsg.setFileSize(message.getFileSize());
            chatMsg.setMimeType(message.getMimeType());
        }
        if (message.getReplyToId() != null) {
            chatMsg.setReplyToId(message.getReplyToId());
            chatMsg.setReplyToContent(message.getReplyToContent());
            chatMsg.setReplyToSender(message.getReplyToSender());
            ChatMessage parent = chatMessageRepository.findById(message.getReplyToId()).orElse(null);
            if (parent != null) {
                chatMsg.setThreadRootId(parent.getThreadRootId() != null ? parent.getThreadRootId() : parent.getId());
            }
        }
        chatMessageRepository.save(chatMsg);

        message.setId(chatMsg.getId());
        message.setSenderName(authUser);
        message.setStatus(Status.MESSAGE);
        message.setMessageType(chatMsg.getMessageType());
        message.setEdited(chatMsg.isEdited());
        fanoutGroupPrivate(chatGroup.getId(), message);
        return message;
    }

    @MessageMapping("/edit-message")
    public Message editMessage(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (message.getId() == null || authUser == null) return null;

        ChatMessage existingMsg = chatMessageRepository.findById(message.getId()).orElse(null);
        if (existingMsg != null && existingMsg.getSenderName().equals(authUser)) {
            if (message.getMessage() != null && message.getMessage().length() > maxMessageLength) {
                sendSystemNotice(authUser, "Mesaj çox uzundur (maksimum " + maxMessageLength + " simvol).");
                return null;
            }
            existingMsg.setContent(escapeHtml(message.getMessage()));
            existingMsg.setEdited(true);
            chatMessageRepository.save(existingMsg);
            
            message.setSenderName(authUser);
            message.setEdited(true);
            message.setMessageType(existingMsg.getMessageType());
            message.setStatus(Status.EDIT);

            if (existingMsg.isPublic()) {
                simpMessagingTemplate.convertAndSend("/chatroom/public", message);
            } else if (existingMsg.getGroup() != null) {
                message.setGroupId(existingMsg.getGroup().getId());
                fanoutGroupPrivate(existingMsg.getGroup().getId(), message);
            } else {
                UserEntity sender = userRepository.findByUsername(authUser).orElse(null);
                UserEntity receiver = userRepository.findByUsername(existingMsg.getReceiverName()).orElse(null);
                if (isBlockedBetween(sender, receiver)) return null;
                simpMessagingTemplate.convertAndSendToUser(authUser, "/private", message);
                simpMessagingTemplate.convertAndSendToUser(existingMsg.getReceiverName(), "/private", message);
            }
        }
        return null;
    }

    @MessageMapping("/delete-message")
    public Message deleteMessage(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (message.getId() == null || authUser == null) return null;

        ChatMessage existingMsg = chatMessageRepository.findById(message.getId()).orElse(null);
        if (existingMsg != null && existingMsg.getSenderName().equals(authUser)) {
            chatMessageRepository.delete(existingMsg);
            
            message.setStatus(Status.DELETE);

            if (existingMsg.isPublic()) {
                simpMessagingTemplate.convertAndSend("/chatroom/public", message);
            } else if (existingMsg.getGroup() != null) {
                message.setGroupId(existingMsg.getGroup().getId());
                fanoutGroupPrivate(existingMsg.getGroup().getId(), message);
            } else {
                UserEntity sender = userRepository.findByUsername(authUser).orElse(null);
                UserEntity receiver = userRepository.findByUsername(existingMsg.getReceiverName()).orElse(null);
                if (isBlockedBetween(sender, receiver)) return null;
                simpMessagingTemplate.convertAndSendToUser(authUser, "/private", message);
                simpMessagingTemplate.convertAndSendToUser(existingMsg.getReceiverName(), "/private", message);
            }
        }
        return null;
    }

    @MessageMapping("/bulk-delete-messages")
    public Message bulkDeleteMessages(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (message.getIds() == null || message.getIds().isEmpty() || authUser == null) return null;

        java.util.List<Long> deletedIds = new java.util.ArrayList<>();
        boolean isPublic = false;
        String receiverName = null;
        Long notifyGroupId = null;

        for (Long id : message.getIds()) {
            ChatMessage existingMsg = chatMessageRepository.findById(id).orElse(null);
            if (existingMsg != null && existingMsg.getSenderName().equals(authUser)) {
                isPublic = existingMsg.isPublic();
                receiverName = existingMsg.getReceiverName();
                if (existingMsg.getGroup() != null) {
                    notifyGroupId = existingMsg.getGroup().getId();
                }
                chatMessageRepository.delete(existingMsg);
                deletedIds.add(id);
            }
        }

        if (!deletedIds.isEmpty()) {
            message.setStatus(Status.BULK_DELETE);
            message.setIds(deletedIds);

            if (isPublic) {
                simpMessagingTemplate.convertAndSend("/chatroom/public", message);
            } else if (notifyGroupId != null) {
                fanoutGroupPrivate(notifyGroupId, message);
            } else {
                UserEntity sender = userRepository.findByUsername(authUser).orElse(null);
                UserEntity receiver = userRepository.findByUsername(receiverName).orElse(null);
                if (isBlockedBetween(sender, receiver)) return null;
                simpMessagingTemplate.convertAndSendToUser(authUser, "/private", message);
                if (receiverName != null) {
                    simpMessagingTemplate.convertAndSendToUser(receiverName, "/private", message);
                }
            }
        }
        return null;
    }

    @MessageMapping("/message-delivered")
    public void messageDelivered(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (message.getId() == null || authUser == null) return;
        
        ChatMessage existingMsg = chatMessageRepository.findById(message.getId()).orElse(null);
        if (existingMsg == null || existingMsg.isPublic()) return;

        // Handle group message delivered
        if (existingMsg.getGroup() != null) {
            if (!groupMemberRepository.existsByChatGroup_IdAndUsername(existingMsg.getGroup().getId(), authUser)) return;
            // For groups, mark as delivered for the sender's display
            message.setStatus(Status.DELIVERED);
            message.setDelivered(true);
            simpMessagingTemplate.convertAndSendToUser(existingMsg.getSenderName(), "/private", message);
            return;
        }

        // Private message delivered
        if (authUser.equals(existingMsg.getReceiverName()) && !existingMsg.isDelivered()) {
            existingMsg.setDelivered(true);
            
            java.time.format.DateTimeFormatter formatter = java.time.format.DateTimeFormatter.ofPattern("HH:mm");
            String timeStr = java.time.LocalDateTime.now().format(formatter);
            existingMsg.setDeliveredAt(timeStr);
            chatMessageRepository.save(existingMsg);
            
            message.setStatus(Status.DELIVERED);
            message.setDelivered(true);
            message.setDeliveredAt(timeStr);
            
            simpMessagingTemplate.convertAndSendToUser(existingMsg.getSenderName(), "/private", message);
        }
    }

    @MessageMapping("/message-read")
    public void messageRead(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (message.getId() == null || authUser == null) return;
        
        ChatMessage existingMsg = chatMessageRepository.findById(message.getId()).orElse(null);
        if (existingMsg == null || existingMsg.isPublic()) return;

        // Respect sendReadReceipts privacy
        UserEntity reader = userRepository.findByUsername(authUser).orElse(null);
        if (reader == null || !reader.isSendReadReceipts()) return;

        // Handle group message read
        if (existingMsg.getGroup() != null) {
            Long groupId = existingMsg.getGroup().getId();
            if (!groupMemberRepository.existsByChatGroup_IdAndUsername(groupId, authUser)) return;

            // Create or update read receipt
            MessageReadReceipt receipt = messageReadReceiptRepository
                .findByMessageIdAndUsername(existingMsg.getId(), authUser)
                .orElse(null);
            if (receipt == null) {
                receipt = new MessageReadReceipt();
                receipt.setMessageId(existingMsg.getId());
                receipt.setUsername(authUser);
                receipt.setReadAt(java.time.LocalDateTime.now());
                messageReadReceiptRepository.save(receipt);

                // Notify sender that someone read their message in group
                Message readUpdate = new Message();
                readUpdate.setId(existingMsg.getId());
                readUpdate.setSenderName(authUser);
                readUpdate.setGroupId(groupId);
                readUpdate.setStatus(Status.READ);
                readUpdate.setRead(true);

                // Fan-out read update to all group members (so sender sees it)
                for (GroupMember member : groupMemberRepository.findByChatGroup_Id(groupId)) {
                    simpMessagingTemplate.convertAndSendToUser(member.getUsername(), "/private", readUpdate);
                }
            }
            return;
        }

        // Private message read
        if (!authUser.equals(existingMsg.getReceiverName()) || existingMsg.isRead()) return;

        existingMsg.setRead(true);
        existingMsg.setDelivered(true);

        java.time.format.DateTimeFormatter formatter = java.time.format.DateTimeFormatter.ofPattern("HH:mm");
        String timeStr = java.time.LocalDateTime.now().format(formatter);
        existingMsg.setReadAt(timeStr);
        if (existingMsg.getDeliveredAt() == null) {
            existingMsg.setDeliveredAt(timeStr);
        }
        chatMessageRepository.save(existingMsg);

        message.setStatus(Status.READ);
        message.setRead(true);
        message.setReadAt(timeStr);

        simpMessagingTemplate.convertAndSendToUser(existingMsg.getSenderName(), "/private", message);
    }

    @MessageMapping("/typing")
    public void typing(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (authUser == null) return;

        Message typing = new Message();
        typing.setSenderName(authUser);
        typing.setReceiverName(message.getReceiverName());
        typing.setGroupId(message.getGroupId());
        typing.setStatus(Status.TYPING);
        typing.setTyping(Boolean.TRUE.equals(message.getTyping()));
        typing.setMessageType(message.getMessageType());

        if (message.getGroupId() != null) {
            if (!groupMemberRepository.existsByChatGroup_IdAndUsername(message.getGroupId(), authUser)) return;
            for (GroupMember member : groupMemberRepository.findByChatGroup_Id(message.getGroupId())) {
                if (!authUser.equals(member.getUsername())) {
                    simpMessagingTemplate.convertAndSendToUser(member.getUsername(), "/private", typing);
                }
            }
            return;
        }

        if (message.getReceiverName() == null) return;
        UserEntity sender = userRepository.findByUsername(authUser).orElse(null);
        UserEntity receiver = userRepository.findByUsername(message.getReceiverName()).orElse(null);
        if (isBlockedBetween(sender, receiver)) return;
        simpMessagingTemplate.convertAndSendToUser(message.getReceiverName(), "/private", typing);
    }

    @MessageMapping("/schedule-message")
    public void scheduleMessage(@Payload Message message, StompHeaderAccessor accessor) {
        String authUser = (String) accessor.getSessionAttributes().get("username");
        if (authUser == null || message.getReceiverName() == null
                || message.getMessage() == null || message.getDate() == null) return;

        // Ban check
        UserEntity sender = userRepository.findByUsername(authUser).orElse(null);
        if (sender != null && sender.isBanned()) {
            sendSystemNotice(authUser, "You are banned and cannot send messages.");
            return;
        }

        UserEntity receiver = userRepository.findByUsername(message.getReceiverName()).orElse(null);
        if (isBlockedBetween(sender, receiver)) {
            sendSystemNotice(authUser, "This private chat is blocked.");
            return;
        }

        try {
            java.time.LocalDateTime scheduledAt = java.time.LocalDateTime.parse(message.getDate());

            ScheduledMessage sm = new ScheduledMessage();
            sm.setSenderName(authUser);
            sm.setReceiverName(message.getReceiverName());
            sm.setContent(message.getMessage());
            sm.setMessageType(message.getMessageType() != null ? message.getMessageType() : "TEXT");
            sm.setScheduledAt(scheduledAt);
            sm.setPublic(false);
            sm.setSent(false);
            if (message.getReplyToId() != null) {
                sm.setReplyToId(message.getReplyToId());
                sm.setReplyToContent(message.getReplyToContent());
                sm.setReplyToSender(message.getReplyToSender());
            }
            scheduledMessageRepository.save(sm);

            // Confirm to sender
            sendSystemNotice(authUser, "Message scheduled for " + scheduledAt.format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm")));
        } catch (Exception e) {
            sendSystemNotice(authUser, "Failed to schedule message. Please check the time format.");
        }
    }
}
