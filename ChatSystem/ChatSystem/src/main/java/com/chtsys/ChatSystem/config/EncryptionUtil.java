package com.chtsys.ChatSystem.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * AES-256-GCM symmetric encryption utility for message content.
 *
 * Security properties:
 *  - AES-256-GCM: authenticated encryption (no padding oracle, integrity check)
 *  - Random 96-bit IV per encryption (prepended to ciphertext)
 *  - Key is externalized to application.properties (app.encryption.secret)
 *
 * Wire format (Base64 of): [12 bytes IV][16 bytes auth tag][N bytes ciphertext]
 */
@Component
public class EncryptionUtil {

    private static final String ALGORITHM  = "AES/GCM/NoPadding";
    private static final int    IV_LEN     = 12;  // 96-bit recommended for GCM
    private static final int    TAG_BITS   = 128; // 128-bit auth tag

    /** Loaded from app.encryption.secret in application.properties */
    private static byte[] SECRET_KEY;

    @Value("${app.encryption.secret}")
    public void setSecretKey(String base64Key) {
        SECRET_KEY = Base64.getDecoder().decode(base64Key);
        if (SECRET_KEY.length != 32) {
            throw new IllegalArgumentException(
                "app.encryption.secret must be a Base64-encoded 32-byte (256-bit) key");
        }
    }

    private static SecretKey buildKey() {
        return new SecretKeySpec(SECRET_KEY, "AES");
    }

    /**
     * Encrypts plaintext with AES-256-GCM.
     * Returns Base64( IV || ciphertext+tag ) or {@code null} if input is null.
     */
    public static String encrypt(String value) {
        if (value == null) return null;
        try {
            byte[] iv = new byte[IV_LEN];
            new SecureRandom().nextBytes(iv);

            Cipher cipher = Cipher.getInstance(ALGORITHM);
            cipher.init(Cipher.ENCRYPT_MODE, buildKey(), new GCMParameterSpec(TAG_BITS, iv));
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));

            // Prepend IV to ciphertext
            byte[] combined = ByteBuffer.allocate(IV_LEN + encrypted.length)
                    .put(iv).put(encrypted).array();
            return Base64.getEncoder().encodeToString(combined);
        } catch (Exception e) {
            throw new RuntimeException("Error encrypting value", e);
        }
    }

    /**
     * Decrypts a value produced by {@link #encrypt}.
     * Falls back to returning the value as-is if it is not valid Base64 or
     * is too short to be encrypted data (backwards compatibility with legacy plaintext rows).
     * Returns null if the value IS valid encrypted format but decryption fails,
     * preventing accidental exposure of raw ciphertext.
     */
    public static String decrypt(String value) {
        if (value == null) return null;
        try {
            byte[] combined;
            try {
                combined = Base64.getDecoder().decode(value);
            } catch (IllegalArgumentException ex) {
                return value;
            }
            if (combined.length <= IV_LEN) {
                return value;
            }

            byte[] iv = new byte[IV_LEN];
            byte[] ciphertext = new byte[combined.length - IV_LEN];

            System.arraycopy(combined, 0, iv, 0, IV_LEN);
            System.arraycopy(combined, IV_LEN, ciphertext, 0, ciphertext.length);

            Cipher cipher = Cipher.getInstance(ALGORITHM);
            cipher.init(Cipher.DECRYPT_MODE, buildKey(), new GCMParameterSpec(TAG_BITS, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
