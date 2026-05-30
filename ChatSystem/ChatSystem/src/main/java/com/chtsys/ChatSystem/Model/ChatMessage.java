package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

import java.time.LocalDateTime;

@Entity
@Table(name = "chat_messages")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class ChatMessage {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String senderName;

    @Column
    private String receiverName;

    @Column(nullable = false, columnDefinition = "TEXT")
    @Convert(converter = com.chtsys.ChatSystem.config.MessageCryptoConverter.class)
    private String content;

    @Column
    private String messageType; // "TEXT", "IMAGE", "AUDIO"

    @Column(nullable = false)
    private LocalDateTime timestamp;

    @Enumerated(EnumType.STRING)
    private Status status;

    @Column(nullable = false)
    private boolean isPublic;

    @Column(columnDefinition = "boolean default false")
    private boolean edited = false;

    @Column(columnDefinition = "boolean default false")
    private boolean delivered = false;

    @Column(columnDefinition = "boolean default false")
    private boolean isRead = false;

    private String deliveredAt;
    private String readAt;

    // Reply fields
    private Long replyToId;

    // Thread root — all replies in a thread share the same root ID
    private Long threadRootId;

    @Column(columnDefinition = "TEXT")
    @Convert(converter = com.chtsys.ChatSystem.config.MessageCryptoConverter.class)
    private String replyToContent;

    private String replyToSender;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "group_id")
    private ChatGroup group;

    // Forward tracking
    private Long forwardedFrom;

    @Column(columnDefinition = "boolean default false")
    private boolean pinned = false;

    // File message metadata
    private String fileName;
    private Long fileSize;
    private String mimeType;
}

