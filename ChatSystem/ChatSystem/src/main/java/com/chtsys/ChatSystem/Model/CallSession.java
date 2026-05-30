package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.*;

import java.time.LocalDateTime;

/**
 * Persistent record of call sessions for tracking active calls,
 * preventing concurrent calls, and maintaining call history.
 */
@Entity
@Table(name = "call_sessions")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CallSession {
    
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    
    /** Unique identifier for this call (UUID) */
    @Column(nullable = false, unique = true, length = 36)
    private String callId;
    
    /** Username of the caller */
    @Column(nullable = false)
    private String caller;
    
    /** Username of the callee */
    @Column(nullable = false)
    private String callee;
    
    /** Type of call: "audio" or "video" */
    @Column(nullable = false, length = 10)
    private String callType;
    
    /** Current status: "ringing", "active", "ended", "rejected", "timeout" */
    @Column(nullable = false, length = 20)
    private String status;
    
    /** When the call was initiated */
    @Column(nullable = false)
    private LocalDateTime startedAt;
    
    /** When the call was answered (null if not answered) */
    @Column
    private LocalDateTime answeredAt;
    
    /** When the call ended */
    @Column
    private LocalDateTime endedAt;
    
    /** Duration in seconds (calculated when call ends) */
    @Column
    private Long durationSeconds;
    
    /** For group calls: group ID */
    @Column
    private Long groupId;
    
    /** Who ended the call */
    @Column(length = 100)
    private String endedBy;
    
    /** Reason for call end: "normal", "rejected", "timeout", "error", "busy" */
    @Column(length = 20)
    private String endReason;
}
