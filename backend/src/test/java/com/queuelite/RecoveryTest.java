package com.queuelite;

import static org.assertj.core.api.Assertions.assertThat;

import com.queuelite.auth.Scrypt;
import com.queuelite.support.Api;
import com.queuelite.support.ApiTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** The break-glass sign-in, with a recovery code configured. */
class RecoveryTest extends ApiTestBase {

    static final String CODE = "Xk2pQ9rT7vW1yZ3a5b7c";
    static final String CODE_HASH = Scrypt.hash(CODE);

    @DynamicPropertySource
    static void recoveryCode(DynamicPropertyRegistry registry) {
        registry.add("STAFF_RECOVERY_CODE_HASH", () -> CODE_HASH);
    }

    @BeforeEach
    void reset() {
        limiter.reset();
    }

    private Api.Response recover(Api client, String body) {
        return client.post("/api/auth/recover", body);
    }

    @Test
    void theRecoveryCodeOpensTheDeskWhenThePasscodeIsForgotten() {
        Api.Response response = recover(api, "{\"code\":\"" + CODE + "\"}");
        assertThat(response.status()).isEqualTo(200);
        assertThat(response.data().get("via").asText()).isEqualTo("recovery");
        assertThat(response.headers().firstValue("set-cookie").orElse("")).contains("ql_session=").contains("HttpOnly");
    }

    @Test
    void aSessionOpenedWithTheRecoveryCodeSaysSo() {
        api.keepCookie(recover(api, "{\"code\":\"" + CODE + "\"}"));
        Api.Response session = api.get("/api/auth/session");
        assertThat(session.status()).isEqualTo(200);
        assertThat(session.data().get("via").asText()).isEqualTo("recovery");
        assertThat(session.data().get("recovery_available").asBoolean()).isTrue();
    }

    @Test
    void anOrdinaryPasscodeSignInIsNotMarkedAsRecovery() {
        Api staff = signedIn();
        assertThat(staff.get("/api/auth/session").data().get("via").asText()).isEqualTo("passcode");
    }

    @Test
    void aWrongEmptyOrMissingCodeIsRefusedAndIssuesNoSession() {
        for (String body : new String[] {"{\"code\":\"wrong\"}", "{\"code\":\"\"}", "{}", "{\"code\":12}", ""}) {
            Api.Response response = recover(api, body);
            assertThat(response.status()).as(body).isEqualTo(401);
            assertThat(response.headers().firstValue("set-cookie")).isEmpty();
            assertThat(response.text()).doesNotContain(CODE);
        }
    }

    @Test
    void thePasscodeIsNotARecoveryCodeOrTheReverse() {
        assertThat(recover(api, "{\"code\":\"" + PASSCODE + "\"}").status()).isEqualTo(401);
        assertThat(api.post("/api/auth/login", "{\"passcode\":\"" + CODE + "\"}").status()).isEqualTo(401);
    }

    @Test
    void recoveryIsRateLimitedHard() {
        for (int attempt = 0; attempt < 10; attempt++) {
            recover(api, "{\"code\":\"wrong\"}");
        }
        Api.Response limited = recover(api, "{\"code\":\"" + CODE + "\"}");
        assertThat(limited.status()).isEqualTo(429);
        assertThat(limited.body().get("error").asText()).isEqualTo("Too many recovery attempts. Try again later.");
    }
}
