package com.queuelite.whatsapp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.queuelite.config.AppConfig;
import com.queuelite.config.BackgroundTasks;
import com.queuelite.notifier.Notifier;
import com.queuelite.queue.Clinic;
import com.queuelite.queue.QueueRules;
import com.queuelite.queue.QueueService;
import com.queuelite.queue.QueueState;
import com.queuelite.queue.Token;
import com.queuelite.util.IstTime;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Patients message the clinic's WhatsApp number to ask where they stand. The
 * reply lands inside the 24h service window they just opened, so it can be
 * free-form text rather than an approved template.
 */
@RestController
@RequestMapping("/api/whatsapp")
public class WhatsAppWebhookController {

    private static final Logger log = LoggerFactory.getLogger(WhatsAppWebhookController.class);

    private final AppConfig config;
    private final QueueService queue;
    private final Notifier notifier;
    private final ObjectMapper json;
    private final BackgroundTasks background;

    public WhatsAppWebhookController(AppConfig config, QueueService queue, Notifier notifier, ObjectMapper json,
                                     BackgroundTasks background) {
        this.config = config;
        this.queue = queue;
        this.notifier = notifier;
        this.json = json;
        this.background = background;
    }

    /** Meta's one-time subscription handshake. */
    @GetMapping("/webhook")
    public ResponseEntity<String> verify(@RequestParam(name = "hub.mode", required = false) String mode,
                                         @RequestParam(name = "hub.verify_token", required = false) String token,
                                         @RequestParam(name = "hub.challenge", required = false) String challenge) {
        if ("subscribe".equals(mode) && token != null && token.equals(config.whatsapp().verifyToken())) {
            log.info("whatsapp webhook verified");
            return ResponseEntity.ok().contentType(MediaType.TEXT_PLAIN).body(challenge == null ? "" : challenge);
        }

        log.warn("whatsapp webhook verification rejected");
        return ResponseEntity.status(403).contentType(MediaType.TEXT_PLAIN).body("Forbidden");
    }

    @PostMapping("/webhook")
    public ResponseEntity<String> receive(@RequestHeader(name = "X-Hub-Signature-256", required = false) String signature,
                                          @RequestBody(required = false) byte[] rawBody) {
        // Without this check anyone who learns the URL could feed us fake
        // patient messages. Meta signs the exact bytes it sent.
        if (!hasValidSignature(signature, rawBody, config.whatsapp().appSecret())) {
            log.warn("whatsapp webhook signature mismatch");
            return ResponseEntity.status(403).contentType(MediaType.TEXT_PLAIN).body("Forbidden");
        }

        // Acknowledge immediately - Meta retries anything slower than a few seconds.
        background.execute(() -> handle(rawBody));
        return ResponseEntity.ok().contentType(MediaType.TEXT_PLAIN).body("OK");
    }

    public static boolean hasValidSignature(String header, byte[] body, String appSecret) {
        if (header == null || body == null || appSecret == null || appSecret.isEmpty()) {
            return false;
        }

        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(appSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String expected = "sha256=" + HexFormat.of().formatHex(mac.doFinal(body));
            return MessageDigest.isEqual(header.getBytes(StandardCharsets.UTF_8),
                    expected.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException | InvalidKeyException error) {
            return false;
        }
    }

    void handle(byte[] rawBody) {
        try {
            JsonNode payload = json.readTree(rawBody);
            List<JsonNode> messages = new ArrayList<>();
            payload.path("entry").forEach(entry ->
                    entry.path("changes").forEach(change ->
                            change.path("value").path("messages").forEach(messages::add)));

            if (messages.isEmpty()) {
                return;
            }

            Optional<Clinic> clinic = queue.findClinic(config.clinicSlug());
            if (clinic.isEmpty()) {
                log.error("whatsapp bot: clinic not found slug={}", config.clinicSlug());
                return;
            }

            for (JsonNode message : messages) {
                String from = message.path("from").asText("");

                if (!"text".equals(message.path("type").asText())) {
                    notifier.replyToPatient(from, "Send any message to check your place in the queue.");
                    continue;
                }

                log.info("whatsapp message received type=text");
                notifier.replyToPatient(from, statusReply(clinic.get(), from));
            }
        } catch (Exception error) {
            log.error("whatsapp webhook handling failed: {}", error.getMessage());
        }
    }

    public String statusReply(Clinic clinic, String phone) {
        Optional<Token> found = queue.findActiveByPhone(clinic.id(), phone);
        boolean hasPhone = clinic.phone() != null && !clinic.phone().isEmpty();

        if (found.isEmpty()) {
            return "We could not find an active token for this number at " + clinic.name() + " today. "
                    + "Please check with the front desk" + (hasPhone ? " or call " + clinic.phone() : "") + ".";
        }

        Token token = found.get();
        QueueState state = queue.state(clinic, false);
        String link = notifier.trackingUrl(clinic.slug(), token.id());

        if (Token.IN_PROGRESS.equals(token.status())) {
            return "It's your turn now - token #" + token.tokenNumber() + ". Please go in.";
        }

        int ahead = QueueRules.countPatientsAhead(state.tokens(), token);
        String nowServing = state.currentTokenNumber() != null
                ? "Now serving #" + state.currentTokenNumber() + "."
                : "The queue has not started yet.";

        if (ahead == 0) {
            return "You're next - token #" + token.tokenNumber() + ". " + nowServing + " Track: " + link;
        }

        String aheadLabel = ahead + " " + (ahead == 1 ? "patient" : "patients") + " ahead of you";
        Instant readyAt = QueueRules.estimateReadyAt(ahead, state.minutesPerPatient(), queue.now());

        // Past closing the arithmetic still produces a time, but one the clinic
        // will not be open at. Say so plainly instead of quoting it.
        if (QueueRules.isAfterClosing(readyAt, clinic, queue.now())) {
            return "Your token is #" + token.tokenNumber() + ". " + nowServing + " " + aheadLabel + ", "
                    + "which is more than we can see before closing today. Please call the "
                    + "front desk" + (hasPhone ? " on " + clinic.phone() : "") + " to check. Track: " + link;
        }

        // A clock time is what someone forty back can actually act on.
        return "Your token is #" + token.tokenNumber() + ". " + nowServing + " "
                + aheadLabel + " - around " + IstTime.formatClock(readyAt) + ". "
                + "We'll message you when you're close. Track: " + link;
    }
}
