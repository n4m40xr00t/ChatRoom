package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

import java.time.LocalDateTime;

@Entity
@Table(name = "scheduled_messages")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class ScheduledMessage {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String senderName;

    @Column
    private String receiverName;

    @Column(nullable = false, columnDefinition = "TEXT")
    private String content;

    @Column
    private String messageType = "TEXT";

    @Column(nullable = false)
    private LocalDateTime scheduledAt;

    @Column(nullable = false)
    private boolean isPublic = false;

    @Column(columnDefinition = "boolean default false")
    private boolean sent = false;

    // Reply fields (optional for scheduled messages too)
    private Long replyToId;

    @Column(columnDefinition = "TEXT")
    private String replyToContent;

    private String replyToSender;
}
