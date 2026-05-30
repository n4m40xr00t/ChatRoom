package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.CallSession;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

@Repository
public interface CallSessionRepository extends JpaRepository<CallSession, Long> {
    
    /**
     * Find an active call session by call ID
     */
    Optional<CallSession> findByCallId(String callId);
    
    /**
     * Check if a user is currently in an active call (status = 'ringing' or 'active')
     */
    @Query("SELECT COUNT(c) > 0 FROM CallSession c WHERE (c.caller = ?1 OR c.callee = ?1) " +
           "AND c.status IN ('ringing', 'active')")
    boolean isUserInActiveCall(String username);
    
    /**
     * Find all active calls for a user
     */
    @Query("SELECT c FROM CallSession c WHERE (c.caller = ?1 OR c.callee = ?1) " +
           "AND c.status IN ('ringing', 'active')")
    List<CallSession> findActiveCallsForUser(String username);
    
    /**
     * Find call history for a user (last N calls)
     */
    @Query("SELECT c FROM CallSession c WHERE (c.caller = ?1 OR c.callee = ?1) " +
           "ORDER BY c.startedAt DESC")
    List<CallSession> findCallHistoryForUser(String username);
    
    /**
     * Find ringing calls that have timed out (older than specified time)
     */
    @Query("SELECT c FROM CallSession c WHERE c.status = 'ringing' AND c.startedAt < ?1")
    List<CallSession> findTimedOutRingingCalls(LocalDateTime cutoffTime);
    
    /**
     * Count total calls between two users
     */
    @Query("SELECT COUNT(c) FROM CallSession c WHERE " +
           "(c.caller = ?1 AND c.callee = ?2) OR (c.caller = ?2 AND c.callee = ?1)")
    long countCallsBetweenUsers(String user1, String user2);
}
