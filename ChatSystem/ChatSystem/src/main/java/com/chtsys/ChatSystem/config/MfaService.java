package com.chtsys.ChatSystem.config;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.client.j2se.MatrixToImageWriter;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import dev.samstevens.totp.code.*;
import dev.samstevens.totp.secret.DefaultSecretGenerator;
import dev.samstevens.totp.secret.SecretGenerator;
import dev.samstevens.totp.time.SystemTimeProvider;
import dev.samstevens.totp.time.TimeProvider;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.util.Base64;

/**
 * Service for TOTP-based Multi-Factor Authentication.
 *
 * Security properties:
 *  - TOTP (RFC 6238): 6-digit codes, 30-second window, SHA-1 (standard for authenticator apps)
 *  - Allows ±1 time-step tolerance to handle clock skew
 *  - Secrets are 160-bit Base32 strings (20 bytes of entropy)
 *  - QR codes are generated server-side and returned as base64 data-URIs (never stored)
 */
@Service
public class MfaService {

    private static final String ISSUER = "ChatRoom";
    private static final int    QR_SIZE = 200; // pixels

    private final SecretGenerator secretGenerator = new DefaultSecretGenerator(20);
    private final TimeProvider    timeProvider    = new SystemTimeProvider();
    private final CodeGenerator   codeGenerator   = new DefaultCodeGenerator(HashingAlgorithm.SHA1, 6);
    private final CodeVerifier    codeVerifier;

    public MfaService() {
        // Allow ±1 time-step (30 s each) to tolerate minor clock skew
        this.codeVerifier = new DefaultCodeVerifier(codeGenerator, timeProvider);
        ((DefaultCodeVerifier) this.codeVerifier).setTimePeriod(30);
        ((DefaultCodeVerifier) this.codeVerifier).setAllowedTimePeriodDiscrepancy(1);
    }

    /** Generates a new Base32-encoded TOTP secret. */
    public String generateSecret() {
        return secretGenerator.generate();
    }

    /**
     * Verifies a 6-digit TOTP code against the stored secret.
     *
     * @param secret  Base32-encoded secret stored for the user
     * @param code    6-digit code entered by the user
     * @return true if the code is valid within the allowed time window
     */
    public boolean verifyCode(String secret, String code) {
        if (secret == null || code == null) return false;
        // Strip any spaces the user may have typed
        String cleaned = code.replaceAll("\\s", "");
        if (cleaned.length() != 6) return false;
        try {
            return codeVerifier.isValidCode(secret, cleaned);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Builds the otpauth:// URI used by authenticator apps.
     *
     * @param username the account label shown in the app
     * @param secret   Base32-encoded secret
     * @return otpauth URI string
     */
    public String buildOtpAuthUri(String username, String secret) {
        return String.format(
            "otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=6&period=30",
            ISSUER,
            encodeUriComponent(username),
            secret,
            ISSUER
        );
    }

    /**
     * Generates a QR code PNG for the given otpauth URI and returns it as a
     * base64-encoded data-URI suitable for use in an {@code <img src="...">}.
     *
     * @param otpAuthUri the otpauth:// URI
     * @return "data:image/png;base64,..." string
     */
    public String generateQrCodeDataUri(String otpAuthUri) {
        try {
            QRCodeWriter writer = new QRCodeWriter();
            BitMatrix matrix = writer.encode(otpAuthUri, BarcodeFormat.QR_CODE, QR_SIZE, QR_SIZE);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            MatrixToImageWriter.writeToStream(matrix, "PNG", baos);
            return "data:image/png;base64," + Base64.getEncoder().encodeToString(baos.toByteArray());
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate QR code", e);
        }
    }

    /** Minimal percent-encoding for the label part of the otpauth URI. */
    private String encodeUriComponent(String value) {
        return value.replace(" ", "%20").replace("@", "%40").replace(":", "%3A");
    }
}
