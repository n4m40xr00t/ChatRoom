package com.chtsys.ChatSystem.controller;

import com.chtsys.ChatSystem.Model.*;
import com.chtsys.ChatSystem.config.LoginRateLimiter;
import com.chtsys.ChatSystem.repository.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.util.regex.Pattern;

@Controller
public class PageController {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ContactRepository contactRepository;

    @Autowired
    private InvitationRepository invitationRepository;

    @Autowired
    private ChatGroupRepository groupRepository;

    @Autowired
    private GroupMemberRepository memberRepository;

    @Autowired
    private BCryptPasswordEncoder passwordEncoder;

    @Autowired
    private UserSessionRepository userSessionRepository;

    @Autowired
    private LoginRateLimiter loginRateLimiter;

    @Autowired
    private FileRecordRepository fileRecordRepository;

    @Autowired
    private GroupMemberRepository groupMemberRepository;

    @Autowired
    private com.chtsys.ChatSystem.config.RateLimiter rateLimiter;

    private static final int REGISTER_MAX_ATTEMPTS = 3;
    private static final int REGISTER_WINDOW_MINUTES = 60;
    private static final int REGISTER_LOCKOUT_MINUTES = 120;

    // Valid email pattern
    private static final Pattern EMAIL_PATTERN =
        Pattern.compile("^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$");

    // Strong password pattern (min 8 chars, 1 upper, 1 lower, 1 digit, 1 special)
    private static final String PASSWORD_PATTERN =
        "^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}$";

    @GetMapping("/")
    public String index(HttpSession session) {
        if (session.getAttribute("username") != null) {
            return "redirect:/chat";
        }
        return "redirect:/login";
    }

    @GetMapping("/login")
    public String loginPage(HttpSession session) {
        if (session.getAttribute("username") != null) {
            return "redirect:/chat";
        }
        return "login";
    }

    @PostMapping("/authenticate-user")
    public String login(@RequestParam String username, @RequestParam String password,
                        HttpServletRequest request, HttpSession session,
                        RedirectAttributes redirectAttributes) {

        // ---- Rate limiting (brute-force protection) ----
        // Key on both username AND remote IP so neither can be abused independently
        String remoteIp = extractClientIp(request);
        String rateLimitKey = username.toLowerCase().trim() + "@" + remoteIp;

        if (loginRateLimiter.isBlocked(rateLimitKey)) {
            long minsLeft = loginRateLimiter.getLockoutMinutesRemaining(rateLimitKey);
            redirectAttributes.addAttribute("error",
                "Too many failed login attempts. Please try again in " + minsLeft + " minute(s).");
            return "redirect:/login";
        }

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user != null && passwordEncoder.matches(password, user.getPassword())) {
            if (user.isBanned()) {
                redirectAttributes.addAttribute("error", "Your account has been banned.");
                return "redirect:/login";
            }

            // Successful login — clear rate-limit counter
            loginRateLimiter.recordSuccess(rateLimitKey);

            // ---- MFA check: if enabled, redirect to OTP step instead of completing login ----
            if (user.isMfaEnabled()) {
                // Invalidate the current session and create a fresh one,
                // so the pending MFA state lives in a new, clean session
                // (prevents session fixation and ensures the old session
                // cannot be reused before MFA is completed).
                request.getSession().invalidate();
                HttpSession mfaSession = request.getSession(true);
                mfaSession.setAttribute(com.chtsys.ChatSystem.controller.MfaController.SESSION_PENDING_MFA_USER, username);
                return "redirect:/mfa-verify";
            }

            // Rotate session ID to prevent session fixation attacks
            request.getSession().invalidate();
            HttpSession newSession = request.getSession(true);

            user.setOnline(true);
            userRepository.save(user);
            newSession.setAttribute("username", username);
            newSession.setAttribute("userId", user.getId());

            // Record session
            UserSession userSession = new UserSession();
            userSession.setUser(user);
            userSession.setSessionId(newSession.getId());

            // SECURITY: extract only the first (real) IP from X-Forwarded-For
            userSession.setIpAddress(remoteIp);

            String userAgent = request.getHeader("User-Agent");
            if (userAgent != null && userAgent.length() > 500) {
                userAgent = userAgent.substring(0, 500);
            }
            userSession.setUserAgent(userAgent);
            userSessionRepository.save(userSession);

            // ---- Bridge to Spring Security ----
            // Manually populate SecurityContext so Spring Security recognizes the user as authenticated
            Authentication auth = new UsernamePasswordAuthenticationToken(username, null,
                user.isAdmin() ? AuthorityUtils.createAuthorityList("ROLE_ADMIN", "ROLE_USER") : AuthorityUtils.createAuthorityList("ROLE_USER"));
            SecurityContext sc = SecurityContextHolder.getContext();
            sc.setAuthentication(auth);
            newSession.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, sc);

            return "redirect:/chat";
        }

        // Failed login — record for rate limiting
        loginRateLimiter.recordFailure(rateLimitKey);
        redirectAttributes.addAttribute("error", "Invalid username or password.");
        return "redirect:/login";
    }

    /**
     * Extracts the real client IP from X-Forwarded-For.
     * Takes ONLY the first entry (the real client) — the rest can be forged.
     */
    private String extractClientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank() && !"unknown".equalsIgnoreCase(xff)) {
            // X-Forwarded-For can be "client, proxy1, proxy2" — take only the first part
            String firstIp = xff.split(",")[0].trim();
            if (!firstIp.isEmpty()) return firstIp;
        }
        return request.getRemoteAddr();
    }

    @PostMapping("/users/save")
    public String registerUser(@RequestParam String email, @RequestParam String name,
                               @RequestParam String surname, @RequestParam String username,
                               @RequestParam String password,
                               @RequestParam String confirmPassword,
                               @RequestParam(required = false) String bio,
                               @RequestParam(required = false) MultipartFile profilePhoto,
                               HttpServletRequest request,
                               RedirectAttributes redirectAttributes) {
        // ---- Rate limiting per IP ----
        String remoteIp = extractClientIp(request);
        String rateLimitKey = "register:" + remoteIp;
        if (rateLimiter.isBlocked(rateLimitKey)) {
            redirectAttributes.addAttribute("error", "Too many registration attempts. Please try again later.");
            return "redirect:/users/create-account";
        }

        if (!password.equals(confirmPassword)) {
            rateLimiter.recordFailure(rateLimitKey, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MINUTES, REGISTER_LOCKOUT_MINUTES);
            redirectAttributes.addAttribute("error", "Passwords do not match.");
            return "redirect:/users/create-account";
        }

        if (email == null || !EMAIL_PATTERN.matcher(email.trim()).matches()) {
            rateLimiter.recordFailure(rateLimitKey, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MINUTES, REGISTER_LOCKOUT_MINUTES);
            redirectAttributes.addAttribute("error", "Please enter a valid email address.");
            return "redirect:/users/create-account";
        }

        if (!password.matches(PASSWORD_PATTERN)) {
            rateLimiter.recordFailure(rateLimitKey, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MINUTES, REGISTER_LOCKOUT_MINUTES);
            redirectAttributes.addAttribute("error", "Password must be at least 8 characters and contain an uppercase, a lowercase, a digit, and a special character (@$!%*?&).");
            return "redirect:/users/create-account";
        }
        if (userRepository.findByUsername(username).isPresent()) {
            rateLimiter.recordFailure(rateLimitKey, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MINUTES, REGISTER_LOCKOUT_MINUTES);
            redirectAttributes.addAttribute("error", "Registration failed. Please check your details and try again.");
            return "redirect:/users/create-account";
        }

        UserEntity newUser = new UserEntity();
        newUser.setEmail(cleanText(email, 180));
        newUser.setName(cleanText(name, 80));
        newUser.setSurname(cleanText(surname, 80));
        newUser.setUsername(cleanText(username, 60));
        newUser.setPassword(passwordEncoder.encode(password));
        newUser.setBio(cleanText(bio, 280));
        newUser.setLastSeenAt(LocalDateTime.now());
        newUser.setCreatedAt(LocalDateTime.now());

        if (profilePhoto != null && !profilePhoto.isEmpty()) {
            if (profilePhoto.getSize() > 5 * 1024 * 1024 || !isAllowedImage(profilePhoto)) {
                redirectAttributes.addAttribute("error", "Profile photo must be a PNG, JPG, GIF, or WebP image under 5 MB");
                return "redirect:/users/create-account";
            }
            String photoUrl = saveProfilePhotoFile(profilePhoto);
            if (photoUrl != null) newUser.setProfilePicture(photoUrl);
        }

        userRepository.save(newUser);
        return "redirect:/login";
    }

    @GetMapping("/chat")
    public String chatPage(HttpSession session, Model model) {
        String username = (String) session.getAttribute("username");
        if (username == null) return "redirect:/login";
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        model.addAttribute("username", username);
        model.addAttribute("user", new MockUser(
                user != null ? user.getName() + " " + user.getSurname() : username,
                true,
                user != null ? user.getProfilePicture() : null
        ));
        model.addAttribute("theme",  user != null && user.getTheme()  != null ? user.getTheme()  : "dark");
        model.addAttribute("chatBg", user != null && user.getChatBg() != null ? user.getChatBg() : "bubbles");
        return "chat";
    }

    @GetMapping("/call")
    public String callPage(HttpSession session, Model model) {
        String username = (String) session.getAttribute("username");
        if (username == null) return "redirect:/login";
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        model.addAttribute("username", username);
        model.addAttribute("theme",  user != null && user.getTheme()  != null ? user.getTheme()  : "dark");
        return "call";
    }

    @GetMapping("/logout")
    public String logout(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username != null) {
            userRepository.findByUsername(username).ifPresent(user -> {
                user.setOnline(false);
                user.setLastSeenAt(LocalDateTime.now());
                userRepository.save(user);
            });
        }
        session.invalidate();
        return "redirect:/login";
    }

    @GetMapping("/users/create-account")
    public String createAccountPage() {
        return "create-account";
    }



    @GetMapping("/settings")
    public String settingsPage(HttpSession session, Model model) {
        String username = (String) session.getAttribute("username");
        if (username == null) {
            return "redirect:/login";
        }
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        model.addAttribute("username", username);
        model.addAttribute("user", new SettingsUser(
            user != null ? user.getName() : "",
            user != null ? user.getSurname() : "",
            user != null ? (user.getName() != null ? user.getName() + " " + user.getSurname() : username) : username,
            user != null ? user.getEmail() : "",
            user != null ? user.getProfilePicture() : null,
            user != null ? user.getBio() : "",
            user != null ? user.getCreatedAt() : null
        ));
        model.addAttribute("createdAt", user != null ? user.getCreatedAt() : null);
        model.addAttribute("theme",  user != null && user.getTheme()  != null ? user.getTheme()  : "dark");
        model.addAttribute("chatBg", user != null && user.getChatBg() != null ? user.getChatBg() : "bubbles");
        return "settings";
    }

    private String cleanText(String value, int maxLength) {
        if (value == null) return null;
        String cleaned = value.trim()
            .replaceAll("<[^>]*>", "")
            .replaceAll("[\\p{Cntrl}&&[^\r\n\t]]", "");
        return cleaned.length() > maxLength ? cleaned.substring(0, maxLength) : cleaned;
    }

    private boolean isAllowedImage(MultipartFile file) {
        String type = file.getContentType();
        return type != null && (type.equals("image/png") || type.equals("image/jpeg") || type.equals("image/webp") || type.equals("image/gif"));
    }

    @GetMapping("/admin")
    public String adminPage(HttpSession session, Model model) {
        String username = (String) session.getAttribute("username");
        if (username == null) return "redirect:/login";
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        // SECURITY: check isAdmin flag; "admin" username kept as fallback for initial setup
        if (user == null || (!user.isAdmin() && !"admin".equals(username))) {
            return "redirect:/chat";
        }
        model.addAttribute("username", username);
        model.addAttribute("theme",  user.getTheme()  != null ? user.getTheme()  : "dark");
        model.addAttribute("chatBg", user.getChatBg() != null ? user.getChatBg() : "bubbles");
        return "admin";
    }

    // SettingsUser DTO for settings page
    public static class SettingsUser {
        private String name;
        private String surname;
        private String fullname;
        private String email;
        private String profilePicture;
        private String bio;
        private String createdAt;

        public SettingsUser(String name, String surname, String fullname, String email, String profilePicture, String bio, java.time.LocalDateTime createdAt) {
            this.name = name;
            this.surname = surname;
            this.fullname = fullname;
            this.email = email;
            this.profilePicture = profilePicture;
            this.bio = bio;
            this.createdAt = createdAt != null ? createdAt.toString() : null;
        }
        public String getName() { return name; }
        public String getSurname() { return surname; }
        public String getFullname() { return fullname; }
        public String getEmail() { return email; }
        public String getProfilePicture() { return profilePicture; }
        public String getBio() { return bio; }
        public String getCreatedAt() { return createdAt; }
    }

    @GetMapping("/invite/{token}")
    public String handleInviteLink(@PathVariable String token,
                                   @RequestParam(required = false) Long group,
                                   HttpSession session,
                                   RedirectAttributes redirectAttributes,
                                   Model model) {
        String username = (String) session.getAttribute("username");
        if (username == null) {
            return "redirect:/login?error=Please log in to accept the invitation.";
        }

        UserEntity currentUser = userRepository.findByUsername(username).orElse(null);
        Invitation invite = invitationRepository.findByToken(token).orElse(null);

        if (invite == null) {
            redirectAttributes.addFlashAttribute("errorMessage", "Invalid invitation link.");
            return "redirect:/settings";
        }
        if (invite.isUsed() && invite.getGroupId() == null) {
            redirectAttributes.addFlashAttribute("errorMessage", "Invitation link has already been used.");
            return "redirect:/settings";
        }

        // Check expiration
        if (invite.getExpiresAt() != null && invite.getExpiresAt().isBefore(java.time.LocalDateTime.now())) {
            redirectAttributes.addFlashAttribute("errorMessage", "Invitation link has expired.");
            return "redirect:/settings";
        }

        // Check group invite usage limit
        {
            int maxUses = invite.getMaxUses() != null ? invite.getMaxUses() : 0;
            int useCount = invite.getUseCount() != null ? invite.getUseCount() : 0;
            if (invite.getGroupId() != null && maxUses > 0 && useCount >= maxUses) {
                redirectAttributes.addFlashAttribute("errorMessage", "This invite link has reached its usage limit and is no longer valid.");
                return "redirect:/settings";
            }
        }

        // ---- Group invite handling ----
        if (invite.getGroupId() != null) {
            // Accept the group invite via internal logic
            try {
                org.springframework.web.client.RestTemplate rt = new org.springframework.web.client.RestTemplate();
                // We handle it directly here instead of calling the API
                Long groupId = invite.getGroupId();
                ChatGroup chatGroup = groupRepository.findById(groupId).orElse(null);
                if (chatGroup == null) {
                    model.addAttribute("errorMessage", "Group not found.");
                    return "invitation";
                }

                if (memberRepository.existsByChatGroup_IdAndUsername(groupId, username)) {
                    redirectAttributes.addFlashAttribute("infoMessage", "You are already a member of this group.");
                    return "redirect:/settings";
                }

                GroupMember member = new GroupMember();
                member.setChatGroup(chatGroup);
                member.setUsername(username);
                member.setRole(GroupRole.MEMBER);
                memberRepository.save(member);

                // Increment use count for limited-use invites
                invite.setUseCount((invite.getUseCount() != null ? invite.getUseCount() : 0) + 1);
                invitationRepository.save(invite);

                redirectAttributes.addFlashAttribute("successMessage", "You joined the group \"" + chatGroup.getName() + "\"!");
                return "redirect:/settings";
            } catch (Exception e) {
                redirectAttributes.addFlashAttribute("errorMessage", "Failed to join group.");
                return "redirect:/settings";
            }
        }

        UserEntity inviter = invite.getInviter();
        if (inviter.getUsername().equals(currentUser.getUsername())) {
            return "redirect:/chat";
        }

        if (!contactRepository.existsByOwnerAndContactUser(currentUser, inviter)) {
            Contact c1 = new Contact();
            c1.setOwner(currentUser);
            c1.setContactUser(inviter);
            contactRepository.save(c1);
        }

        if (!contactRepository.existsByOwnerAndContactUser(inviter, currentUser)) {
            Contact c2 = new Contact();
            c2.setOwner(inviter);
            c2.setContactUser(currentUser);
            contactRepository.save(c2);
        }

        invite.setUsed(true);
        invitationRepository.save(invite);

        redirectAttributes.addFlashAttribute("successMessage", "Successfully added " + inviter.getUsername() + " to your contacts!");
        return "redirect:/settings";
    }

    @GetMapping("/uploads/profiles/{filename:.+}")
    public ResponseEntity<Resource> serveProfilePhoto(@PathVariable String filename, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        if (filename.contains("..") || filename.contains("/") || filename.contains("\\"))
            return ResponseEntity.badRequest().build();

        Path filePath = Paths.get("uploads", "profiles", filename);
        File file = filePath.toFile();
        if (!file.exists() || !file.isFile())
            return ResponseEntity.notFound().build();

        Resource resource = new FileSystemResource(file);
        String mimeType;
        try {
            mimeType = Files.probeContentType(filePath);
        } catch (IOException e) {
            mimeType = "application/octet-stream";
        }
        if (mimeType == null) mimeType = "application/octet-stream";

        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType(mimeType))
            .header(HttpHeaders.CONTENT_DISPOSITION, "inline")
            .body(resource);
    }

    @GetMapping("/uploads/{filename:.+}")
    public ResponseEntity<Resource> serveFile(@PathVariable String filename, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        if (filename.contains("..") || filename.contains("/") || filename.contains("\\"))
            return ResponseEntity.badRequest().build();

        // Check access via FileRecord
        FileRecord fr = fileRecordRepository.findByStoredName(filename).orElse(null);
        if (fr == null) return ResponseEntity.notFound().build();

        boolean allowed = fr.getSenderUsername().equals(username);
        if (!allowed && fr.isPublic()) allowed = true;
        if (!allowed && fr.getReceiverUsername() != null && fr.getReceiverUsername().equals(username)) allowed = true;
        if (!allowed && fr.getGroupId() != null) {
            allowed = groupMemberRepository.existsByChatGroup_IdAndUsername(fr.getGroupId(), username);
        }
        if (!allowed) return ResponseEntity.status(403).build();

        Path filePath = Paths.get("uploads", filename);
        File file = filePath.toFile();
        if (!file.exists() || !file.isFile())
            return ResponseEntity.notFound().build();

        Resource resource = new FileSystemResource(file);
        String mimeType;
        try {
            mimeType = Files.probeContentType(filePath);
        } catch (IOException e) {
            mimeType = "application/octet-stream";
        }
        if (mimeType == null) mimeType = "application/octet-stream";

        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType(mimeType))
            .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + file.getName() + "\"")
            .body(resource);
    }

    private String saveProfilePhotoFile(MultipartFile file) {
        try {
            String mimeType = file.getContentType();
            String ext = switch (mimeType != null ? mimeType : "") {
                case "image/png" -> ".png";
                case "image/jpeg" -> ".jpg";
                case "image/webp" -> ".webp";
                case "image/gif" -> ".gif";
                default -> ".jpg";
            };
            String storedName = java.util.UUID.randomUUID().toString() + ext;
            Path dir = Paths.get("uploads", "profiles");
            Files.createDirectories(dir);
            file.transferTo(dir.resolve(storedName));
            return "/uploads/profiles/" + storedName;
        } catch (Exception e) {
            return null;
        }
    }

    // MockUser class for Thymeleaf templates
    public static class MockUser {
        private String fullname;
        private boolean status;
        private String profilePicture;

        public MockUser(String fullname, boolean status, String profilePicture) {
            this.fullname = fullname;
            this.status = status;
            this.profilePicture = profilePicture;
        }
        public String getFullname() { return fullname; }
        public boolean isStatus() { return status; }
        public String getProfilePicture() { return profilePicture; }
    }
}
