package com.chtsys.ChatSystem;

import com.chtsys.ChatSystem.config.MfaService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class MfaServiceTest {

    private MfaService mfaService;

    @BeforeEach
    void setUp() {
        mfaService = new MfaService();
    }

    @Test
    void testGenerateSecret() {
        String secret = mfaService.generateSecret();
        assertNotNull(secret);
        assertTrue(secret.length() >= 16);
    }

    @Test
    void testBuildOtpAuthUri() {
        String secret = "JBSWY3DPEHPK3PXP";
        String username = "testuser@example.com";
        String uri = mfaService.buildOtpAuthUri(username, secret);
        
        assertTrue(uri.startsWith("otpauth://totp/ChatRoom:testuser%40example.com"));
        assertTrue(uri.contains("secret=" + secret));
        assertTrue(uri.contains("issuer=ChatRoom"));
    }

    @Test
    void testVerifyCodeInvalid() {
        String secret = "JBSWY3DPEHPK3PXP";
        // Assuming "000000" is almost certainly invalid for a static random time
        assertFalse(mfaService.verifyCode(secret, "000000"));
        assertFalse(mfaService.verifyCode(secret, "123")); // wrong length
        assertFalse(mfaService.verifyCode(null, "123456"));
    }

    @Test
    void testGenerateQrCodeDataUri() {
        String uri = "otpauth://totp/ChatRoom:test?secret=JBSWY3DPEHPK3PXP";
        String qrDataUri = mfaService.generateQrCodeDataUri(uri);
        
        assertNotNull(qrDataUri);
        assertTrue(qrDataUri.startsWith("data:image/png;base64,"));
    }
}
