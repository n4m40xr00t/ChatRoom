package com.chtsys.ChatSystem.config;

import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class RateLimiter {

    private final ConcurrentHashMap<String, AttemptRecord> records = new ConcurrentHashMap<>();

    public boolean isBlocked(String key) {
        AttemptRecord rec = records.get(normalise(key));
        if (rec == null) return false;
        if (rec.lockedUntil != null && LocalDateTime.now().isBefore(rec.lockedUntil)) {
            return true;
        }
        if (rec.lockedUntil != null) {
            records.remove(normalise(key));
        }
        return false;
    }

    public long getLockoutMinutesRemaining(String key) {
        AttemptRecord rec = records.get(normalise(key));
        if (rec == null || rec.lockedUntil == null) return 0;
        long mins = java.time.Duration.between(LocalDateTime.now(), rec.lockedUntil).toMinutes();
        return Math.max(0, mins + 1);
    }

    public void recordFailure(String key, int maxAttempts, int windowMinutes, int lockoutMinutes) {
        String k = normalise(key);
        records.compute(k, (__, rec) -> {
            if (rec == null) rec = new AttemptRecord();
            if (rec.firstAttemptAt.plusMinutes(windowMinutes).isBefore(LocalDateTime.now())) {
                rec = new AttemptRecord();
            }
            rec.count++;
            if (rec.count >= maxAttempts) {
                rec.lockedUntil = LocalDateTime.now().plusMinutes(lockoutMinutes);
            }
            return rec;
        });
    }

    public void recordSuccess(String key) {
        records.remove(normalise(key));
    }

    private String normalise(String key) {
        return key == null ? "" : key.toLowerCase().trim();
    }

    private static class AttemptRecord {
        int count;
        LocalDateTime firstAttemptAt;
        LocalDateTime lockedUntil;

        AttemptRecord() {
            this.count = 0;
            this.firstAttemptAt = LocalDateTime.now();
            this.lockedUntil = null;
        }
    }
}