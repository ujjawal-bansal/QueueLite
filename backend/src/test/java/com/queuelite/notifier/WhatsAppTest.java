package com.queuelite.notifier;

import static org.assertj.core.api.Assertions.assertThat;

import com.queuelite.whatsapp.WhatsAppWebhookController;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

class WhatsAppTest {

    @Test
    void aBareTenDigitIndianNumberGetsTheCountryCode() {
        assertThat(WhatsAppClient.toE164("9876543210", "91")).isEqualTo("919876543210");
    }

    @Test
    void formattingCharactersAreStripped() {
        assertThat(WhatsAppClient.toE164("98765 43210", "91")).isEqualTo("919876543210");
        assertThat(WhatsAppClient.toE164("(987) 654-3210", "91")).isEqualTo("919876543210");
    }

    @Test
    void anAlreadyPrefixedNumberIsLeftAlone() {
        assertThat(WhatsAppClient.toE164("+91 98765 43210", "91")).isEqualTo("919876543210");
    }

    @Test
    void aLocalNumberWrittenBehindAZeroStillGetsItsCountryCode() {
        assertThat(WhatsAppClient.toE164("0 63966 34403", "91")).isEqualTo("916396634403");
        assertThat(WhatsAppClient.toE164("00919876543210", "91")).isEqualTo("919876543210");
    }

    static String sign(String body, String secret) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return "sha256=" + HexFormat.of().formatHex(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void aCorrectlySignedPayloadIsAccepted() throws Exception {
        String body = "{\"entry\":[]}";
        assertThat(WhatsAppWebhookController.hasValidSignature(sign(body, "s3cret"),
                body.getBytes(StandardCharsets.UTF_8), "s3cret")).isTrue();
    }

    @Test
    void aPayloadSignedWithTheWrongSecretOrTamperedWithIsRejected() throws Exception {
        String body = "{\"entry\":[]}";
        assertThat(WhatsAppWebhookController.hasValidSignature(sign(body, "other"),
                body.getBytes(StandardCharsets.UTF_8), "s3cret")).isFalse();
        assertThat(WhatsAppWebhookController.hasValidSignature(sign(body, "s3cret"),
                "{\"entry\":[1]}".getBytes(StandardCharsets.UTF_8), "s3cret")).isFalse();
    }

    @Test
    void aMissingSignatureOrBodyIsRejected() {
        assertThat(WhatsAppWebhookController.hasValidSignature(null, new byte[0], "s3cret")).isFalse();
        assertThat(WhatsAppWebhookController.hasValidSignature("sha256=00", null, "s3cret")).isFalse();
    }
}
