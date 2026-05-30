package com.chtsys.ChatSystem.config;

import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory login brute-force protection.
 *
 * Rules:
 *  - After MAX_ATTEMPTS failed logins for a given key (username or IP),
 *    the key is locked for LOCKOUT_MINUTES.
 *  - The attempt window resets after WINDOW_MINUTES of no activity.
 *  - On a successful login the counter is cleared.
 */
@Component
public class LoginRateLimiter {

    private static final int MAX_ATTEMPTS     = 5;
    private static final int WINDOW_MINUTES   = 10;
    private static final int LOCKOUT_MINUTES  = 15;

    private static class AttemptRecord {
        int count;
        LocalDateTime firstAttemptAt;
        LocalDateTime lockedUntil;

        AttemptRecord() {
            this.count          = 0;
            this.firstAttemptAt = LocalDateTime.now();
            this.lockedUntil    = null;
        }
    }

    private final ConcurrentHashMap<String, AttemptRecord> records = new ConcurrentHashMap<>();

    /**
     * Returns true if the given key is currently blocked (too many failed attempts).
     */
    public boolean isBlocked(String key) {
        AttemptRecord rec = records.get(normalise(key));
        if (rec == null) return false;
        if (rec.lockedUntil != null && LocalDateTime.now().isBefore(rec.lockedUntil)) {
            return true;
        }
        // Lock expired — clear it
        if (rec.lockedUntil != null) {
            records.remove(normalise(key));
        }
        return false;
    }

    /**
     * Returns how many minutes remain on the lockout, or 0 if not locked.
     */
    public long getLockoutMinutesRemaining(String key) {
        AttemptRecord rec = records.get(normalise(key));
        if (rec == null || rec.lockedUntil == null) return 0;
        long mins = java.time.Duration.between(LocalDateTime.now(), rec.lockedUntil).toMinutes();
        return Math.max(0, mins + 1); // round up
    }

    /**
     * Records a failed login attempt for the given key.
     * Call AFTER verifying the password failed.
     */
    public void recordFailure(String key) {
        String k = normalise(key);
        records.compute(k, (__, rec) -> {
            if (rec == null) rec = new AttemptRecord();

            // Reset window if it expired
            if (rec.firstAttemptAt.plusMinutes(WINDOW_MINUTES).isBefore(LocalDateTime.now())) {
                rec = new AttemptRecord();
            }

            rec.count++;
            if (rec.count >= MAX_ATTEMPTS) {
                rec.lockedUntil = LocalDateTime.now().plusMinutes(LOCKOUT_MINUTES);
            }
            return rec;
        });
    }

    /**
     * Clears all failure records for the given key (call on successful login).
     */
    public void recordSuccess(String key) {
        records.remove(normalise(key));
    }

    private String normalise(String key) {
        return key == null ? "" : key.toLowerCase().trim();
    }
}
