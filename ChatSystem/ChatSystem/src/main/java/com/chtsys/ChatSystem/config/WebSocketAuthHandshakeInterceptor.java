package com.chtsys.ChatSystem.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import jakarta.servlet.http.HttpSession;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Binds the logged-in HTTP session username into WebSocket session attributes
 * so STOMP handlers never trust client-sent usernames for authentication.
 * Also validates the Origin header against the configured allowed origins
 * to prevent cross-origin WebSocket hijacking.
 */
@Component
public class WebSocketAuthHandshakeInterceptor implements HandshakeInterceptor {

    public static final String USERNAME_ATTR = "username";
    public static final String ALLOWED_ORIGINS_ATTR = "allowedOrigins";

    @Value("${app.allowed-origins:*}")
    private String[] allowedOrigins;

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Map<String, Object> attributes) {
        // ---- Origin validation ----
        String origin = request.getHeaders().getOrigin();
        if (origin != null && !origin.isBlank()) {
            List<String> origins = Arrays.asList(allowedOrigins);
            boolean wildcard = origins.size() == 1 && "*".equals(origins.get(0));
            if (!wildcard) {
                boolean allowed = origins.stream().anyMatch(origin::equalsIgnoreCase);
                if (!allowed) {
                    return false;
                }
            }
        }

        // ---- Extract authenticated username ----
        if (request instanceof ServletServerHttpRequest servletRequest) {
            HttpSession session = servletRequest.getServletRequest().getSession(false);
            if (session != null) {
                Object u = session.getAttribute(USERNAME_ATTR);
                if (u instanceof String s && !s.isBlank()) {
                    attributes.put(USERNAME_ATTR, s);
                }
            }
        }
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               WebSocketHandler wsHandler, Exception exception) {
    }
}
