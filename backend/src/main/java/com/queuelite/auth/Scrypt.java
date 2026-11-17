package com.queuelite.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import org.bouncycastle.crypto.generators.SCrypt;

/**
 * "scrypt$&lt;salt&gt;$&lt;hex&gt;" hashes, byte-for-byte compatible with the Node
 * API's crypto.scryptSync(value, salt, 64): N=16384, r=8, p=1, and the salt
 * used as its UTF-8 text. Existing STAFF_PASSCODE_HASH values keep working.
 */
public final class Scrypt {

    private static final int N = 16384;
    private static final int R = 8;
    private static final int P = 1;
    private static final int KEY_LENGTH = 64;
    private static final SecureRandom RANDOM = new SecureRandom();

    private Scrypt() {}

    public static byte[] derive(String value, String salt) {
        return SCrypt.generate(value.getBytes(StandardCharsets.UTF_8),
                salt.getBytes(StandardCharsets.UTF_8), N, R, P, KEY_LENGTH);
    }

    public static String hash(String value) {
        byte[] saltBytes = new byte[16];
        RANDOM.nextBytes(saltBytes);
        String salt = HexFormat.of().formatHex(saltBytes);
        return "scrypt$" + salt + "$" + HexFormat.of().formatHex(derive(value, salt));
    }

    /**
     * Compares in constant time so a correct value cannot be found by timing.
     *
     * @throws IllegalStateException when the stored hash is not in the expected
     *     shape - a configuration error, not a wrong guess
     */
    public static boolean verify(Object value, String storedHash, String envName) {
        if (!(value instanceof String text) || text.isEmpty()) {
            return false;
        }

        String[] parts = (storedHash == null ? "" : storedHash).split("\\$", -1);

        if (parts.length != 3 || !parts[0].equals("scrypt")) {
            throw new IllegalStateException(envName + " is malformed - regenerate it with the "
                    + (envName.equals("STAFF_PASSCODE_HASH") ? "hash-passcode" : "generate-recovery")
                    + " tool");
        }

        byte[] expected;
        try {
            expected = HexFormat.of().parseHex(parts[2]);
        } catch (IllegalArgumentException error) {
            return false;
        }

        byte[] actual = derive(text, parts[1]);
        return actual.length == expected.length && MessageDigest.isEqual(actual, expected);
    }
}
