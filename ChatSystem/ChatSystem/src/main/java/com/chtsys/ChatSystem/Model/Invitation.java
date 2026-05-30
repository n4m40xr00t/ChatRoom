package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

import java.time.LocalDateTime;

@Entity
@Table(name = "invitations")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class Invitation {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "inviter_id", nullable = false)
    private UserEntity inviter;

    @Column(nullable = false, unique = true)
    private String token;

    @Column(nullable = false)
    private LocalDateTime createdAt;
    
    @Column(nullable = false)
    private boolean used;

    @Column
    private Long groupId; // nullable - if set, this invite is for joining a group

    /** Maximum number of times this invite can be used (0 = unlimited). null maps to 0. */
    @Column
    private Integer maxUses = 0;

    /** How many times this invite has been used. null maps to 0. */
    @Column
    private Integer useCount = 0;

    /** When this invite expires (null = never). */
    @Column
    private LocalDateTime expiresAt;
}
