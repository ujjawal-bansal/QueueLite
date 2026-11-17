package com.queuelite;

import static org.assertj.core.api.Assertions.assertThat;

import com.queuelite.support.Api;
import com.queuelite.support.ApiTestBase;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Health, headers, CORS, rate limits and the edges of the API. */
class PlumbingTest extends ApiTestBase {

    @BeforeEach
    void reset() {
        limiter.reset();
    }

    private HttpResponse<String> raw(HttpRequest.Builder request) throws Exception {
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
    }

    @Test
    void healthAnswersWithoutTheDatabase() {
        Api.Response health = api.get("/api/health");
        assertThat(health.status()).isEqualTo(200);
        assertThat(health.body().get("message").asText()).isEqualTo("QueueLite running");
        assertThat(health.data().get("clinic_slug").asText()).isEqualTo("test-clinic");
    }

    @Test
    void theBareRootExplainsItselfInsteadOfLookingBroken() {
        Api.Response root = api.get("/");
        assertThat(root.status()).isEqualTo(200);
        assertThat(root.body().get("service").asText()).isEqualTo("queuelite-api");
        assertThat(root.data().get("health").asText()).isEqualTo("/api/health");
    }

    @Test
    void theClinicIsPublicButOnlyItsListing() {
        Api.Response clinic = api.get("/api/clinic");
        assertThat(clinic.status()).isEqualTo(200);
        assertThat(clinic.data().get("name").asText()).isEqualTo("Dev Eye Care");
        assertThat(clinic.data().get("opens_at").asText()).isEqualTo("10:00:00");
        assertThat(clinic.data().has("avg_consult_minutes")).isFalse();
    }

    @Test
    void unknownRoutesAreAJson404() {
        Api.Response missing = api.get("/api/nothing-here");
        assertThat(missing.status()).isEqualTo(404);
        assertThat(missing.body().get("success").asBoolean()).isFalse();
        assertThat(missing.body().get("error").asText()).isEqualTo("Not found");
        assertThat(api.get("/api/clinics/somewhere-else/board").status()).isEqualTo(404);
    }

    @Test
    void securityHeadersAreSetOnEveryResponse() {
        Api.Response health = api.get("/api/health");
        assertThat(health.headers().firstValue("x-content-type-options")).hasValue("nosniff");
        assertThat(health.headers().firstValue("x-frame-options")).hasValue("SAMEORIGIN");
        assertThat(health.headers().firstValue("strict-transport-security")).isPresent();
        assertThat(health.headers().firstValue("content-security-policy")).isPresent();
    }

    @Test
    void theFrontendOriginMayCallTheApiWithItsCookie() throws Exception {
        HttpResponse<String> preflight = raw(request("/api/auth/login")
                .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                .header("Origin", "http://localhost:5173")
                .header("Access-Control-Request-Method", "POST")
                .header("Access-Control-Request-Headers", "content-type"));

        assertThat(preflight.statusCode()).isEqualTo(200);
        assertThat(preflight.headers().firstValue("access-control-allow-origin")).hasValue("http://localhost:5173");
        assertThat(preflight.headers().firstValue("access-control-allow-credentials")).hasValue("true");
    }

    @Test
    void anyOtherOriginIsNotGrantedAccess() throws Exception {
        HttpResponse<String> response = raw(request("/api/health").header("Origin", "https://evil.example"));
        assertThat(response.headers().firstValue("access-control-allow-origin")).isEmpty();
    }

    @Test
    void theSessionCookieIsHttpOnly() {
        Api.Response login = api.signIn(PASSCODE);
        assertThat(login.status()).isEqualTo(200);
        assertThat(login.headers().firstValue("set-cookie").orElseThrow())
                .contains("ql_session=").contains("HttpOnly").contains("SameSite=Lax").contains("Path=/");
    }

    @Test
    void aWrongPasscodeIsRefused() {
        Api.Response login = api.post("/api/auth/login", "{\"passcode\":\"guess\"}");
        assertThat(login.status()).isEqualTo(401);
        assertThat(login.body().get("error").asText()).isEqualTo("Incorrect passcode");
        assertThat(api.post("/api/auth/login", "{\"passcode\":12345}").status()).isEqualTo(401);
        assertThat(api.post("/api/auth/login", "").status()).isEqualTo(401);
    }

    @Test
    void signingOutClearsTheCookie() {
        Api.Response logout = api.post("/api/auth/logout", null);
        assertThat(logout.status()).isEqualTo(200);
        assertThat(logout.headers().firstValue("set-cookie").orElseThrow()).contains("Max-Age=0");
    }

    @Test
    void withNoRecoveryCodeTheRouteReports404Not403() {
        assertThat(api.post("/api/auth/recover", "{\"code\":\"anything\"}").status()).isEqualTo(404);
    }

    @Test
    void signInAttemptsAreRateLimited() {
        for (int attempt = 0; attempt < 30; attempt++) {
            api.post("/api/auth/login", "{\"passcode\":\"guess\"}");
        }
        Api.Response limited = api.post("/api/auth/login", "{\"passcode\":\"" + PASSCODE + "\"}");
        assertThat(limited.status()).isEqualTo(429);
        assertThat(limited.headers().firstValue("ratelimit-policy")).hasValue("30;w=900");
    }

    @Test
    void staffRoutesNeedASession() {
        assertThat(api.get(CLINIC + "/queue/today").status()).isEqualTo(401);
        assertThat(api.get("/api/auth/session").status()).isEqualTo(401);
        assertThat(api.post(CLINIC + "/call-next", null).status()).isEqualTo(401);
    }
}
