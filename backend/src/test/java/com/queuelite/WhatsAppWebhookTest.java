package com.queuelite;

import static org.assertj.core.api.Assertions.assertThat;

import com.queuelite.queue.Clinic;
import com.queuelite.support.Api;
import com.queuelite.support.ApiTestBase;
import com.queuelite.support.TestDatabase;
import com.queuelite.whatsapp.WhatsAppWebhookController;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** Patients messaging the clinic to ask where they stand. */
class WhatsAppWebhookTest extends ApiTestBase {

    @Autowired
    WhatsAppWebhookController webhook;

    private Api staff;
    private Clinic clinic;

    @BeforeEach
    void freshDay() {
        resetDay();
        staff = signedIn();
        clinic = queue.findClinic(TestDatabase.CLINIC_SLUG).orElseThrow();
    }

    @Test
    void metasHandshakeEchoesTheChallengeOnlyForTheRightToken() {
        Api.Response ok = api.get("/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=4242");
        assertThat(ok.status()).isEqualTo(200);
        assertThat(ok.text()).isEqualTo("4242");

        assertThat(api.get("/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1").status())
                .isEqualTo(403);
    }

    @Test
    void anUnsignedOrBadlySignedDeliveryIsRefused() throws Exception {
        String body = "{\"entry\":[]}";
        assertThat(post(body, null).statusCode()).isEqualTo(403);
        assertThat(post(body, "sha256=" + "0".repeat(64)).statusCode()).isEqualTo(403);
        assertThat(post(body, sign(body)).statusCode()).isEqualTo(200);
    }

    @Test
    void anUnknownNumberIsPointedAtTheDesk() {
        assertThat(webhook.statusReply(clinic, "919999999999"))
                .startsWith("We could not find an active token for this number at Dev Eye Care today.")
                .contains("+919368444330");
    }

    @Test
    void aWaitingPatientIsToldTheirPlaceAsAClockTime() {
        for (int index = 1; index <= 4; index++) {
            issue(staff, "Patient " + index, "987650000" + index);
        }
        staff.post(CLINIC + "/call-next", null);

        // WhatsApp delivers E.164, the desk typed ten digits; the last ten match.
        String reply = webhook.statusReply(clinic, "919876500004");
        assertThat(reply).startsWith("Your token is #4. Now serving #1. 2 patients ahead of you - around ")
                .contains("We'll message you when you're close. Track: http://localhost:5173/q/test-clinic/");
        // Two ahead at six minutes each from 10:30.
        assertThat(reply).contains("around 10:42 am");

        assertThat(webhook.statusReply(clinic, "919876500002")).startsWith("You're next - token #2. Now serving #1.");
        assertThat(webhook.statusReply(clinic, "919876500001")).isEqualTo("It's your turn now - token #1. Please go in.");
    }

    private HttpResponse<String> post(String body, String signature) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/whatsapp/webhook"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body));
        if (signature != null) {
            request.header("X-Hub-Signature-256", signature);
        }
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String sign(String body) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec("test-app-secret".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return "sha256=" + HexFormat.of().formatHex(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
    }
}
