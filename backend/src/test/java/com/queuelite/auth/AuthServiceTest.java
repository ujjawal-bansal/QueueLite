package com.queuelite.auth;

import static org.assertj.core.api.Assertions.assertThat;

import com.queuelite.config.AppConfig;
import com.queuelite.support.ApiTestBase;
import com.queuelite.support.MutableClock;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

class AuthServiceTest {

    static final String SECRET = "a".repeat(48);

    static AppConfig config(String recoveryHash) {
        Map<String, String> env = Map.of(
                "DATABASE_URL", "postgresql://u:p@localhost:5432/postgres",
                "FRONTEND_URL", "http://localhost:5173",
                "CLINIC_SLUG", "test-clinic",
                "SESSION_SECRET", SECRET,
                "STAFF_PASSCODE_HASH", ApiTestBase.PASSCODE_HASH,
                "STAFF_RECOVERY_CODE_HASH", recoveryHash);
        return AppConfig.from(env::get);
    }

    final MutableClock clock = new MutableClock();
    final AuthService auth = new AuthService(config(""), clock);

    @Test
    void anIssuedSessionReadsBackAsStaff() {
        StaffSession session = auth.readSession(auth.issueSession("passcode"));
        assertThat(session).isEqualTo(new StaffSession("staff", "test-clinic", "passcode"));
    }

    @Test
    void aSessionExpiresAfterItsTwelveHours() {
        String token = auth.issueSession("passcode");
        clock.advance(Duration.ofHours(13));
        assertThat(auth.readSession(token)).isNull();
    }

    @Test
    void tamperedEmptyAndForeignSignedTokensAreRejected() {
        String token = auth.issueSession("passcode");
        assertThat(auth.readSession(token.substring(0, token.length() - 2) + "xx")).isNull();
        assertThat(auth.readSession("")).isNull();
        assertThat(auth.readSession(null)).isNull();
        assertThat(auth.readSession("not.a.jwt")).isNull();
        assertThat(auth.readSession(nodeStyleJwt("b".repeat(48)))).isNull();
    }

    @Test
    void aSessionIssuedByTheNodeApiIsStillAccepted() {
        // A desk signed in before the switch should not be signed out by it.
        assertThat(auth.readSession(nodeStyleJwt(SECRET)))
                .isEqualTo(new StaffSession("staff", "test-clinic", "passcode"));
    }

    @Test
    void withNoRecoveryCodeConfiguredThereIsNoSecondDoor() {
        assertThat(auth.isRecoveryEnabled()).isFalse();
        assertThat(auth.verifyRecoveryCode("anything")).isFalse();
        assertThat(auth.verifyRecoveryCode(ApiTestBase.PASSCODE)).isFalse();
    }

    /** What jsonwebtoken.sign({ role, clinic, via }, secret, { expiresIn }) produces. */
    private String nodeStyleJwt(String secret) {
        long now = clock.instant().getEpochSecond();
        String header = base64("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String payload = base64("{\"role\":\"staff\",\"clinic\":\"test-clinic\",\"via\":\"passcode\",\"iat\":"
                + now + ",\"exp\":" + (now + 43200) + "}");
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String signature = Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(mac.doFinal((header + "." + payload).getBytes(StandardCharsets.UTF_8)));
            return header + "." + payload + "." + signature;
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private static String base64(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }
}
