package com.chtsys.ChatSystem.controller;

import com.chtsys.ChatSystem.Model.CallSession;
import com.chtsys.ChatSystem.repository.CallSessionRepository;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * REST API for call management and history.
 *
 * Provides endpoints for:
 * - Retrieving call history
 * - Checking if user is in a call
 * - Getting call statistics
 */
@RestController
@RequestMapping("/api/calls")
public class CallApiController {

    @Autowired
    private CallSessionRepository callSessionRepository;

    /**
     * Get call history for the authenticated user
     */
    @GetMapping("/history")
    public ResponseEntity<?> getCallHistory(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) {
            return ResponseEntity.status(401).body(Map.of("error", "Not authenticated"));
        }

        List<CallSession> history = callSessionRepository.findCallHistoryForUser(username);
        return ResponseEntity.ok(history);
    }

    /**
     * Check if user is currently in an active call
     */
    @GetMapping("/active")
    public ResponseEntity<?> checkActiveCall(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) {
            return ResponseEntity.status(401).body(Map.of("error", "Not authenticated"));
        }

        boolean inCall = callSessionRepository.isUserInActiveCall(username);
        List<CallSession> activeCalls = callSessionRepository.findActiveCallsForUser(username);

        Map<String, Object> response = new HashMap<>();
        response.put("inCall", inCall);
        response.put("activeCalls", activeCalls);

        return ResponseEntity.ok(response);
    }

    /**
     * Get call statistics for the authenticated user
     */
    @GetMapping("/stats")
    public ResponseEntity<?> getCallStats(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) {
            return ResponseEntity.status(401).body(Map.of("error", "Not authenticated"));
        }

        List<CallSession> allCalls = callSessionRepository.findCallHistoryForUser(username);

        long totalCalls = allCalls.size();
        long answeredCalls = allCalls.stream().filter(c -> "ended".equals(c.getStatus())).count();
        long missedCalls = allCalls.stream()
                .filter(c -> "timeout".equals(c.getStatus()) || "rejected".equals(c.getStatus()))
                .count();
        long totalDuration = allCalls.stream()
                .filter(c -> c.getDurationSeconds() != null)
                .mapToLong(CallSession::getDurationSeconds)
                .sum();

        Map<String, Object> stats = new HashMap<>();
        stats.put("totalCalls", totalCalls);
        stats.put("answeredCalls", answeredCalls);
        stats.put("missedCalls", missedCalls);
        stats.put("totalDurationSeconds", totalDuration);

        return ResponseEntity.ok(stats);
    }

    /**
     * Get call details by call ID
     */
    @GetMapping("/{callId}")
    public ResponseEntity<?> getCallDetails(@PathVariable String callId, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) {
            return ResponseEntity.status(401).body(Map.of("error", "Not authenticated"));
        }

        CallSession call = callSessionRepository.findByCallId(callId).orElse(null);
        if (call == null) {
            return ResponseEntity.status(404).body(Map.of("error", "Call not found"));
        }

        // Verify user is part of the call
        if (!call.getCaller().equals(username) && !call.getCallee().equals(username)) {
            return ResponseEntity.status(403).body(Map.of("error", "Access denied"));
        }

        return ResponseEntity.ok(call);
    }

    /**
     * Clean up any stale active/ringing sessions for the current user.
     * Called by the chat page on load so a previous crash/force-close
     * doesn't leave the user permanently stuck in "already in a call".
     */
    @PostMapping("/cleanup")
    public ResponseEntity<?> cleanupStaleSessions(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) {
            return ResponseEntity.status(401).body(Map.of("error", "Not authenticated"));
        }

        List<CallSession> stale = callSessionRepository.findActiveCallsForUser(username);
        for (CallSession s : stale) {
            s.setStatus("ended");
            s.setEndedAt(LocalDateTime.now());
            s.setEndedBy(username);
            s.setEndReason("cleanup");
            callSessionRepository.save(s);
        }

        return ResponseEntity.ok(Map.of("cleaned", stale.size()));
    }
}
