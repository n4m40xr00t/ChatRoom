package com.chtsys.ChatSystem.Model;

import lombok.*;

@Getter
@Setter
@AllArgsConstructor
@NoArgsConstructor
@ToString
public class Message {

    private Long id;
    private String senderName;
    private String receiverName;
    private String message;
    private String Date;
    private Status status;
    private String messageType; // "TEXT", "IMAGE", "AUDIO"
    private boolean edited;
    private java.util.List<Long> ids;
    private boolean delivered;
    private boolean isRead;
    private String deliveredAt;
    private String readAt;
    private Boolean typing;
    private String lastSeenAt;
    private String bio;
    private boolean blocked;
    private boolean blockedBy;

    // Reply fields
    private Long replyToId;
    private String replyToContent;
    private String replyToSender;

    // Thread root
    private Long threadRootId;

    /** When set, this is a group chat message (broadcast over per-user /private). */
    private Long groupId;

    // ---- Reaction fields (used for REACTION status broadcasts) ----
    /** Emoji character for a reaction update, e.g. "👍" */
    private String emoji;
    /** Aggregated reaction counts: list of {emoji, count, reactedByMe} maps */
    private java.util.List<java.util.Map<String, Object>> reactions;

    // Forward tracking
    private Long forwardedFrom;

    // File message metadata
    private String fileName;
    private Long fileSize;
    private String mimeType;
}

