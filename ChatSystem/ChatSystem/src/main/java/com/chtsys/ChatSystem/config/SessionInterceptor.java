package com.chtsys.ChatSystem.config;

import com.chtsys.ChatSystem.Model.UserSession;
import com.chtsys.ChatSystem.repository.UserSessionRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.time.LocalDateTime;
import java.util.Optional;

@Component
public class SessionInterceptor implements HandlerInterceptor {

    @Autowired
    private UserSessionRepository userSessionRepository;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        HttpSession session = request.getSession(false);

        if (session != null && session.getAttribute("username") != null) {
            // ---- Active session: validate it is still active in DB ----
            // Use an atomic database operation that checks isActive AND updates lastActive
            // in a single statement. If the session was just revoked, the update affects
            // 0 rows and we reject — eliminating the TOCTOU race condition.
            LocalDateTime now = LocalDateTime.now();
            int updated = userSessionRepository.touchActiveSession(session.getId(), now);
            if (updated == 0) {
                // The session row either doesn't exist or isActive=false
                Optional<UserSession> userSessionOpt = userSessionRepository.findBySessionId(session.getId());
                if (userSessionOpt.isPresent() && !userSessionOpt.get().isActive()) {
                    session.invalidate();
                    if (!request.getRequestURI().startsWith("/api/")) {
                        response.sendRedirect("/login?error=Your session was terminated remotely.");
                    } else {
                        response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Session revoked");
                    }
                    return false;
                }
            }
            return true;
        }

        // ---- No valid session ----
        // Spring Security handles authorization for all paths; this is defence-in-depth.
        // For API paths, Spring Security will return 403; for page paths it will redirect.
        // We simply let the request through here since SecurityConfig handles it.
        return true;
    }
}
