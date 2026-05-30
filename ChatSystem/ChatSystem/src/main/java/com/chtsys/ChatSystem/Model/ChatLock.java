package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "chat_locks")
@Getter
@Setter
@NoArgsConstructor
public class ChatLock {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String ownerUsername;

    // For private chats
    @Column
    private String targetUsername;

    // For group chats
    @Column
    private Long targetGroupId;

    @Column(nullable = false)
    private String passwordHash;
}
