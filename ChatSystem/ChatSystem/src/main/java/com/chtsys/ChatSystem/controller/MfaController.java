package com.chtsys.ChatSystem.controller;

import com.chtsys.ChatSystem.Model.UserEntity;
import com.chtsys.ChatSystem.Model.UserSession;
import com.chtsys.ChatSystem.config.MfaService;
import com.chtsys.ChatSystem.repository.UserRepository;
import com.chtsys.ChatSystem.repository.UserSessionRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.Map;

/**
 * Handles all MFA-related flows:
 *
 *  Login flow:
 *    GET  /mfa-verify          — renders the OTP entry page (after password success)
 *    POST /mfa-verify          — validates OTP and completes login
 *
 *  Settings / management (REST):
 *    POST   /api/mfa/setup     — generates a new secret + QR code (does NOT enable yet)
 *    POST   /api/mfa/confirm   — verifies first code and activates MFA
 *    POST   /api/mfa/disable   — disables MFA (requires current password)
 *    GET    /api/mfa/status    — returns { enabled: bool }
 */
@Controller
public class MfaController {

    /** Session key used to pass the pending username between the password step and the OTP step. */
    public static final String SESSION_PENDING_MFA_USER = "pendingMfaUsername";

    /** Session key for the temporary secret during setup (before confirmation). */
    private static final String SESSION_MFA_SETUP_SECRET = "mfaSetupSecret";

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private UserSessionRepository userSessionRepository;

    @Autowired
    private MfaService mfaService;

    @Autowired
    private org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder passwordEncoder;

    // =========================================================================
    //  Login flow
    // =========================================================================

    /**
     * Renders the MFA verification page.
     * Only accessible when a pending MFA username is stored in the session.
     */
    @GetMapping("/mfa-verify")
    public String mfaVerifyPage(HttpSession session, Model model) {
        String pendingUser = (String) session.getAttribute(SESSION_PENDING_MFA_USER);
        if (pendingUser == null) {
            // No pending MFA — redirect to login
            return "redirect:/login";
        }
        model.addAttribute("username", pendingUser);
        return "mfa-verify";
    }

    /**
     * Validates the submitted OTP code and, if correct, completes the login
     * by creating the full authenticated session (same logic as PageController.login()).
     */
    @PostMapping("/mfa-verify")
    public String mfaVerify(@RequestParam String code,
                            HttpServletRequest request,
                            HttpSession session) {

        String pendingUser = (String) session.getAttribute(SESSION_PENDING_MFA_USER);
        if (pendingUser == null) {
            return "redirect:/login";
        }

        UserEntity user = userRepository.findByUsername(pendingUser).orElse(null);
        if (user == null || !user.isMfaEnabled() || user.getMfaSecret() == null) {
            session.removeAttribute(SESSION_PENDING_MFA_USER);
            return "redirect:/login?error=MFA+configuration+error.";
        }

        if (!mfaService.verifyCode(user.getMfaSecret(), code)) {
            // Invalid code — stay on MFA page with error flag
            return "redirect:/mfa-verify?error=true";
        }

        // ---- Code is valid: complete the login ----
        // Remove the pending marker
        session.removeAttribute(SESSION_PENDING_MFA_USER);

        // Rotate session ID (session fixation protection)
        session.invalidate();
        HttpSession newSession = request.getSession(true);

        user.setOnline(true);
        userRepository.save(user);

        newSession.setAttribute("username", pendingUser);
        newSession.setAttribute("userId", user.getId());

        // Record session in DB
        UserSession userSession = new UserSession();
        userSession.setUser(user);
        userSession.setSessionId(newSession.getId());
        userSession.setIpAddress(extractClientIp(request));
        String ua = request.getHeader("User-Agent");
        if (ua != null && ua.length() > 500) ua = ua.substring(0, 500);
        userSession.setUserAgent(ua);
        userSessionRepository.save(userSession);

        // Bridge to Spring Security
        Authentication auth = new UsernamePasswordAuthenticationToken(
            pendingUser, null,
            user.isAdmin()
                ? AuthorityUtils.createAuthorityList("ROLE_ADMIN", "ROLE_USER")
                : AuthorityUtils.createAuthorityList("ROLE_USER")
        );
        SecurityContext sc = SecurityContextHolder.getContext();
        sc.setAuthentication(auth);
        newSession.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, sc);

        return "redirect:/chat";
    }

    // =========================================================================
    //  Settings / management REST endpoints
    // =========================================================================

    /** Returns the current MFA status for the logged-in user. */
    @GetMapping("/api/mfa/status")
    @ResponseBody
    public ResponseEntity<?> getMfaStatus(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        return ResponseEntity.ok(Map.of("enabled", user.isMfaEnabled()));
    }

    /**
     * Generates a new TOTP secret and QR code for the setup wizard.
     * The secret is stored temporarily in the session — it is NOT saved to the
     * database until the user confirms with a valid code via /api/mfa/confirm.
     */
    @PostMapping("/api/mfa/setup")
    @ResponseBody
    public ResponseEntity<?> setupMfa(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        if (user.isMfaEnabled()) {
            return ResponseEntity.badRequest().body(Map.of("error", "MFA is already enabled."));
        }

        // Generate a fresh secret and store it temporarily in the session
        String secret = mfaService.generateSecret();
        session.setAttribute(SESSION_MFA_SETUP_SECRET, secret);

        String otpUri = mfaService.buildOtpAuthUri(username, secret);
        String qrDataUri = mfaService.generateQrCodeDataUri(otpUri);

        return ResponseEntity.ok(Map.of(
            "secret",  secret,
            "qrCode",  qrDataUri
        ));
    }

    /**
     * Confirms MFA setup by verifying the first TOTP code.
     * Only after a valid code is the secret persisted and MFA marked as enabled.
     */
    @PostMapping("/api/mfa/confirm")
    @ResponseBody
    public ResponseEntity<?> confirmMfa(@RequestBody Map<String, String> body,
                                        HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        if (user.isMfaEnabled()) {
            return ResponseEntity.badRequest().body(Map.of("error", "MFA is already enabled."));
        }

        String pendingSecret = (String) session.getAttribute(SESSION_MFA_SETUP_SECRET);
        if (pendingSecret == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "No MFA setup in progress. Please start setup again."));
        }

        String code = body.get("code");
        if (!mfaService.verifyCode(pendingSecret, code)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid verification code. Please try again."));
        }

        // Code is valid — persist the secret and enable MFA
        user.setMfaSecret(pendingSecret);
        user.setMfaEnabled(true);
        userRepository.save(user);

        // Clean up the temporary session attribute
        session.removeAttribute(SESSION_MFA_SETUP_SECRET);

        return ResponseEntity.ok(Map.of("success", true));
    }

    /**
     * Disables MFA for the logged-in user.
     * Requires the current password as confirmation to prevent unauthorized disabling.
     */
    @PostMapping("/api/mfa/disable")
    @ResponseBody
    public ResponseEntity<?> disableMfa(@RequestBody Map<String, String> body,
                                        HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        if (!user.isMfaEnabled()) {
            return ResponseEntity.badRequest().body(Map.of("error", "MFA is not enabled."));
        }

        // Require current password as a second factor for disabling MFA
        String password = body.get("password");
        if (password == null || password.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "Password is required to disable MFA."));
        }

        if (!passwordEncoder.matches(password, user.getPassword())) {
            return ResponseEntity.status(400).body(Map.of("error", "Incorrect password."));
        }

        user.setMfaEnabled(false);
        user.setMfaSecret(null);
        userRepository.save(user);

        // Also clean up any pending setup secret
        session.removeAttribute(SESSION_MFA_SETUP_SECRET);

        return ResponseEntity.ok(Map.of("success", true));
    }

    // =========================================================================
    //  Helpers
    // =========================================================================

    private String extractClientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank() && !"unknown".equalsIgnoreCase(xff)) {
            String firstIp = xff.split(",")[0].trim();
            if (!firstIp.isEmpty()) return firstIp;
        }
        return request.getRemoteAddr();
    }
}
