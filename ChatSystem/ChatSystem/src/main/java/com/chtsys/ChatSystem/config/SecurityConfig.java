package com.chtsys.ChatSystem.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.filter.OncePerRequestFilter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * Spring Security configuration.
 *
 * Key security decisions:
 *  - CSRF: enabled via CookieCsrfTokenRepository (XSRF-TOKEN cookie readable by JS, HttpOnly=false)
 *  - Authentication: all paths require auth except explicitly permitted public paths
 *  - Spring Security's own login/logout are disabled — we use our own custom endpoints
 *  - H2 console is disabled in application.properties; frameOptions set to DENY as defence-in-depth
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Value("${app.allowed-origins}")
    private String[] allowedOrigins;

    @Bean
    public BCryptPasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration configuration = new CorsConfiguration();
        if (allowedOrigins.length == 1 && "*".equals(allowedOrigins[0])) {
            configuration.setAllowedOriginPatterns(List.of("*"));
        } else {
            configuration.setAllowedOrigins(Stream.of(allowedOrigins).collect(Collectors.toList()));
        }
        configuration.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        configuration.setAllowedHeaders(List.of("*"));
        configuration.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {

        CsrfTokenRequestAttributeHandler requestHandler = new CsrfTokenRequestAttributeHandler();
        requestHandler.setCsrfRequestAttributeName(null);

        http
            // ---- CORS ----
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))

            // ---- CSRF ----
            .csrf(csrf -> csrf
                .csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
                .csrfTokenRequestHandler(requestHandler)
            )
            .addFilterAfter(new OncePerRequestFilter() {
                @Override
                protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
                        throws ServletException, IOException {
                    CsrfToken csrfToken = (CsrfToken) request.getAttribute(CsrfToken.class.getName());
                    if (csrfToken != null) {
                        csrfToken.getToken(); // Forces the token to be resolved and cookie written
                    }
                    filterChain.doFilter(request, response);
                }
            }, org.springframework.security.web.csrf.CsrfFilter.class)

            // ---- Authorization ----
            .authorizeHttpRequests(auth -> auth
                // Public pages & assets
                .requestMatchers(
                    "/", "/login", "/authenticate-user",
                    "/mfa-verify",
                    "/users/create-account", "/users/save",
                    "/css/**", "/js/**", "/images/**", "/fonts/**", "/sounds/**",
                    "/invite/**"
                ).permitAll()
                // Everything else requires an authenticated session
                .anyRequest().authenticated()
            )

            // ---- Disable Spring Security's own login/logout (we use custom controllers) ----
            .formLogin(fl -> fl.disable())
            .logout(lo -> lo.disable())
            .httpBasic(hb -> hb.disable())

            // ---- Channel security: enforced by HttpsRedirectConfig when HTTPS profile is active ----
            // Spring's requiresSecure() provides defence-in-depth on top of Tomcat's redirect.
            .requiresChannel(channel -> {
                String activeProfiles = System.getProperty("spring.profiles.active", "");
                if (activeProfiles.contains("https")) {
                    channel.anyRequest().requiresSecure();
                }
            })

            // ---- Security headers ----
            .headers(h -> h
                .frameOptions(fo -> fo.deny())
                .contentTypeOptions(ct -> ct.and())
            );

        return http.build();
    }
}
