package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

import java.time.LocalDateTime;

@Entity
@Table(name = "users")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class UserEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String username;

    @Column(nullable = false)
    private String password;

    @Column(nullable = false)
    private String email;

    @Column
    private String name;

    @Column
    private String surname;

    @Column(columnDefinition = "TEXT")
    private String profilePicture; // stored as base64 data-URI or filename

    @Column(length = 280)
    private String bio;

    @Column(nullable = false)
    private boolean online = false;

    @Column
    private LocalDateTime lastSeenAt;

    @Column(nullable = false)
    private boolean banned = false;

    @Column(nullable = false)
    private boolean isAdmin = false;

    // ---- Multi-Factor Authentication ----
    @Column(nullable = false, columnDefinition = "boolean default false")
    private boolean mfaEnabled = false;

    /** Base32-encoded TOTP secret (null when MFA is not set up) */
    @Column(length = 64)
    private String mfaSecret;

    // ---- Appearance ----
    /** Theme key, e.g. "dark" (default), "midnight", "ocean", "forest", "rose", "slate" */
    @Column(length = 32, columnDefinition = "varchar(32) default 'dark'")
    private String theme = "dark";

    /** Chat background key, e.g. "none", "dots", "grid", "waves", "bubbles" */
    @Column(length = 32, columnDefinition = "varchar(32) default 'none'")
    private String chatBg = "none";

    /** Account creation timestamp */
    @Column(nullable = false)
    private LocalDateTime createdAt = LocalDateTime.now();

    // ---- Privacy ----
    /** Who can add you as contact: "everyone" or "invitation" */
    @Column(length = 20, columnDefinition = "varchar(20) default 'everyone'")
    private String contactPrivacy = "everyone";

    @Column(nullable = false, columnDefinition = "boolean default true")
    private boolean showOnlineStatus = true;

    @Column(nullable = false, columnDefinition = "boolean default true")
    private boolean sendReadReceipts = true;
}
