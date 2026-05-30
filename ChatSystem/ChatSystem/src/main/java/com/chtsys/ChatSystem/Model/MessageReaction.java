package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

/**
 * Stores a single emoji reaction by one user on one message.
 * The unique constraint (messageId, username) ensures each user
 * can only have one active reaction per message at a time.
 */
@Entity
@Table(
    name = "message_reactions",
    uniqueConstraints = @UniqueConstraint(
        name = "uq_reaction_msg_user",
        columnNames = {"message_id", "username"}
    )
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class MessageReaction {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** The message this reaction belongs to. */
    @Column(name = "message_id", nullable = false)
    private Long messageId;

    /** The username of the person who reacted. */
    @Column(nullable = false, length = 80)
    private String username;

    /**
     * The emoji character(s), e.g. "👍", "❤️", "😂".
     * Stored as UTF-8 text; max 8 chars covers all multi-codepoint emoji.
     */
    @Column(nullable = false, length = 16)
    private String emoji;
}
