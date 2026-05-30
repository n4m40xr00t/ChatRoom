package com.chtsys.ChatSystem.config;


import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocket implements WebSocketMessageBrokerConfigurer {

    /** Comma-separated allowed origins. Set app.allowed-origins in application.properties. */
    @Value("${app.allowed-origins:*}")
    private String[] allowedOrigins;

    @Autowired
    private WebSocketAuthHandshakeInterceptor webSocketAuthHandshakeInterceptor;

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.setApplicationDestinationPrefixes("/app");
        registry.enableSimpleBroker("/chatroom", "/user", "/call");
        registry.setUserDestinationPrefix("/user");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
                .setAllowedOriginPatterns(allowedOrigins)
                .addInterceptors(
                        new org.springframework.web.socket.server.support.HttpSessionHandshakeInterceptor(),
                        webSocketAuthHandshakeInterceptor)
                .withSockJS();
    }

    @Override
    public void configureWebSocketTransport(org.springframework.web.socket.config.annotation.WebSocketTransportRegistration registration) {
        registration.setMessageSizeLimit(6 * 1024 * 1024); // 6 MB (allows server-side validation before reject)
        registration.setSendBufferSizeLimit(8 * 1024 * 1024); // 8 MB
        registration.setSendTimeLimit(20000);
    }

    @org.springframework.context.annotation.Bean
    public org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean createWebSocketContainer() {
        org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean container = new org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(6 * 1024 * 1024); // 6 MB
        container.setMaxBinaryMessageBufferSize(6 * 1024 * 1024); // 6 MB
        return container;
    }
}
