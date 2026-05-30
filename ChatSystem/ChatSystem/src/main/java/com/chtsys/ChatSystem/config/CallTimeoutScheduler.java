package com.chtsys.ChatSystem.config;

import com.chtsys.ChatSystem.controller.CallController;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

/**
 * Scheduled tasks for call management.
 * 
 * Handles automatic timeout of unanswered calls.
 */
@Configuration
@EnableScheduling
public class CallTimeoutScheduler {

    @Autowired
    private CallController callController;

    /**
     * Check for timed-out ringing calls every 10 seconds
     */
    @Scheduled(fixedRate = 10000)
    public void checkCallTimeouts() {
        callController.timeoutRingingCalls();
    }
}
