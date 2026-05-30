package com.chtsys.ChatSystem.config;

import org.apache.catalina.Context;
import org.apache.catalina.connector.Connector;
import org.apache.tomcat.util.descriptor.web.SecurityCollection;
import org.apache.tomcat.util.descriptor.web.SecurityConstraint;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.servlet.server.ServletWebServerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

/**
 * Active only when the "https" Spring profile is enabled.
 *
 * What this does:
 *   1. Spring Boot's main HTTPS connector is already configured by application-https.properties.
 *   2. This bean adds a SECOND plain-HTTP connector on port 8080 (configurable via server.http.port).
 *   3. A Tomcat CONFIDENTIAL security constraint forces every HTTP request to be
 *      redirected (302) to the same path on HTTPS port 8443 automatically.
 *
 * Result: users (and Android devices) can type http://192.168.x.x:8080/
 * and land on https://192.168.x.x:8443/ without any manual URL editing.
 */
@Configuration
@Profile("https")
public class HttpsRedirectConfig {

    /** The plain-HTTP port that receives requests and redirects them to HTTPS. */
    @Value("${server.http.port:8080}")
    private int httpPort;

    /** The HTTPS port that Spring Boot's main SSL connector listens on. */
    @Value("${server.port:8443}")
    private int httpsPort;

    @Bean
    public ServletWebServerFactory servletContainer() {
        TomcatServletWebServerFactory tomcat = new TomcatServletWebServerFactory() {
            @Override
            protected void postProcessContext(Context context) {
                // Mark every URL pattern as CONFIDENTIAL so Tomcat auto-redirects HTTP → HTTPS
                SecurityConstraint constraint = new SecurityConstraint();
                constraint.setUserConstraint("CONFIDENTIAL");
                SecurityCollection collection = new SecurityCollection();
                collection.addPattern("/*");
                constraint.addCollection(collection);
                context.addConstraint(constraint);
            }
        };
        tomcat.addAdditionalTomcatConnectors(httpConnector());
        return tomcat;
    }

    /** Plain-HTTP connector — only redirects, never serves content directly. */
    private Connector httpConnector() {
        Connector connector = new Connector("org.apache.coyote.http11.Http11NioProtocol");
        connector.setScheme("http");
        connector.setPort(httpPort);
        connector.setSecure(false);
        connector.setRedirectPort(httpsPort);
        return connector;
    }
}
