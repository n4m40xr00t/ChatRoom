package com.chtsys.ChatSystem.controller;

import com.chtsys.ChatSystem.Model.ChatLock;
import com.chtsys.ChatSystem.repository.ChatLockRepository;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.util.HashSet;
import java.util.Optional;
import java.util.Set;

@RestController
@RequestMapping("/api/chat-lock")
public class ChatLockController {

    @Autowired
    private ChatLockRepository chatLockRepository;

    @Autowired
    private BCryptPasswordEncoder passwordEncoder;

    static class LockRequest {
        public String targetUsername;
        public Long targetGroupId;
        public String password;
    }

    @PostMapping("/set")
    public ResponseEntity<?> setLock(@RequestBody LockRequest request, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Unauthorized");

        if (request.password == null || request.password.length() < 4) {
            return ResponseEntity.badRequest().body("Password must be at least 4 characters");
        }

        Optional<ChatLock> existing = getExistingLock(username, request.targetUsername, request.targetGroupId);
        ChatLock lock = existing.orElse(new ChatLock());
        
        lock.setOwnerUsername(username);
        lock.setTargetUsername(request.targetUsername);
        lock.setTargetGroupId(request.targetGroupId);
        lock.setPasswordHash(passwordEncoder.encode(request.password));

        chatLockRepository.save(lock);

        // Add to unlocked session set so they don't have to unlock it immediately
        addUnlocked(session, getLockKey(request.targetUsername, request.targetGroupId));

        return ResponseEntity.ok("Chat locked successfully");
    }

    @PostMapping("/verify")
    public ResponseEntity<?> verifyLock(@RequestBody LockRequest request, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Unauthorized");

        Optional<ChatLock> optLock = getExistingLock(username, request.targetUsername, request.targetGroupId);
        if (!optLock.isPresent()) {
            return ResponseEntity.badRequest().body("Chat is not locked");
        }

        ChatLock lock = optLock.get();
        if (passwordEncoder.matches(request.password, lock.getPasswordHash())) {
            addUnlocked(session, getLockKey(request.targetUsername, request.targetGroupId));
            return ResponseEntity.ok("Unlocked");
        } else {
            return ResponseEntity.status(403).body("Invalid password");
        }
    }

    @PostMapping("/remove")
    public ResponseEntity<?> removeLock(@RequestBody LockRequest request, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Unauthorized");

        Optional<ChatLock> optLock = getExistingLock(username, request.targetUsername, request.targetGroupId);
        if (!optLock.isPresent()) {
            return ResponseEntity.badRequest().body("Chat is not locked");
        }

        ChatLock lock = optLock.get();
        if (passwordEncoder.matches(request.password, lock.getPasswordHash())) {
            chatLockRepository.delete(lock);
            return ResponseEntity.ok("Lock removed");
        } else {
            return ResponseEntity.status(403).body("Invalid password");
        }
    }

    @GetMapping("/status")
    public ResponseEntity<?> checkStatus(@RequestParam(required = false) String targetUsername,
                                         @RequestParam(required = false) Long targetGroupId,
                                         HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Unauthorized");

        boolean isLocked = getExistingLock(username, targetUsername, targetGroupId).isPresent();
        boolean isUnlockedInSession = isUnlocked(session, getLockKey(targetUsername, targetGroupId));

        return ResponseEntity.ok(new LockStatus(isLocked, isUnlockedInSession));
    }

    static class LockStatus {
        public boolean locked;
        public boolean unlockedInSession;
        public LockStatus(boolean l, boolean u) { this.locked = l; this.unlockedInSession = u; }
    }

    private Optional<ChatLock> getExistingLock(String owner, String targetUser, Long targetGroup) {
        if (targetUser != null && !targetUser.isEmpty()) {
            return chatLockRepository.findByOwnerUsernameAndTargetUsername(owner, targetUser);
        } else if (targetGroup != null) {
            return chatLockRepository.findByOwnerUsernameAndTargetGroupId(owner, targetGroup);
        }
        return Optional.empty();
    }

    private String getLockKey(String targetUser, Long targetGroup) {
        if (targetUser != null && !targetUser.isEmpty()) return "USER_" + targetUser;
        if (targetGroup != null) return "GROUP_" + targetGroup;
        return "";
    }

    @SuppressWarnings("unchecked")
    private void addUnlocked(HttpSession session, String key) {
        Set<String> unlocked = (Set<String>) session.getAttribute("unlockedChats");
        if (unlocked == null) unlocked = new HashSet<>();
        unlocked.add(key);
        session.setAttribute("unlockedChats", unlocked);
    }

    @SuppressWarnings("unchecked")
    private boolean isUnlocked(HttpSession session, String key) {
        Set<String> unlocked = (Set<String>) session.getAttribute("unlockedChats");
        return unlocked != null && unlocked.contains(key);
    }
}
