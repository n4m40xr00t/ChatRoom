package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

import java.time.LocalDateTime;

@Entity
@Table(name = "message_read_receipts", uniqueConstraints = {
    @UniqueConstraint(columnNames = { "message_id", "username" })
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class MessageReadReceipt {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "message_id", nullable = false)
    private Long messageId;

    @Column(nullable = false)
    private String username;

    @Column(nullable = false)
    private LocalDateTime readAt;
}
