package com.chtsys.ChatSystem.controller;

import com.chtsys.ChatSystem.Model.UserEntity;
import com.chtsys.ChatSystem.Model.UserSession;
import com.chtsys.ChatSystem.repository.UserRepository;
import com.chtsys.ChatSystem.repository.UserSessionRepository;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/sessions")
public class SessionController {

    @Autowired
    private UserSessionRepository userSessionRepository;

    @Autowired
    private UserRepository userRepository;

    @GetMapping
    public ResponseEntity<?> getActiveSessions(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Unauthorized");

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).body("User not found");

        List<UserSession> activeSessions = userSessionRepository.findByUserAndIsActiveTrue(user);
        
        List<SessionDto> sessionDtos = activeSessions.stream().map(s -> {
            boolean isCurrent = s.getSessionId().equals(session.getId());
            return new SessionDto(s.getId(), s.getIpAddress(), s.getUserAgent(), s.getCreatedAt(), s.getLastActive(), isCurrent);
        }).collect(Collectors.toList());

        return ResponseEntity.ok(sessionDtos);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> revokeSession(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Unauthorized");

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).body("User not found");

        Optional<UserSession> optSession = userSessionRepository.findById(id);
        if (optSession.isPresent()) {
            UserSession userSession = optSession.get();
            if (userSession.getUser().getId().equals(user.getId())) {
                userSession.setActive(false);
                userSessionRepository.save(userSession);
                return ResponseEntity.ok("Session revoked");
            } else {
                return ResponseEntity.status(403).body("Forbidden");
            }
        }
        return ResponseEntity.status(404).body("Session not found");
    }

    static class SessionDto {
        public Long id;
        public String ipAddress;
        public String userAgent;
        public LocalDateTime createdAt;
        public LocalDateTime lastActive;
        public boolean isCurrent;

        public SessionDto(Long id, String ipAddress, String userAgent, LocalDateTime createdAt, LocalDateTime lastActive, boolean isCurrent) {
            this.id = id;
            this.ipAddress = ipAddress;
            this.userAgent = userAgent;
            this.createdAt = createdAt;
            this.lastActive = lastActive;
            this.isCurrent = isCurrent;
        }
    }
}
