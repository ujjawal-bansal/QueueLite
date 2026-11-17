package com.queuelite.notifier;

import com.queuelite.config.AppConfig;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * NOTIFIER=whatsapp sends through the WhatsApp Cloud API; NOTIFIER=console (the
 * default) only logs, so the whole app works before WhatsApp is configured.
 * Phone numbers are never written to the log.
 */
@Component
public class MessagingNotifier implements Notifier {

    private static final Logger log = LoggerFactory.getLogger(MessagingNotifier.class);

    private final AppConfig config;
    private final WhatsAppClient whatsapp;

    public MessagingNotifier(AppConfig config, WhatsAppClient whatsapp) {
        this.config = config;
        this.whatsapp = whatsapp;
    }

    @Override
    public String trackingUrl(String slug, UUID tokenId) {
        return config.frontendUrl() + "/q/" + slug + "/" + tokenId;
    }

    @Override
    public boolean isWhatsAppEnabled() {
        return config.useWhatsApp();
    }

    @Override
    public boolean canSendHeadsUp() {
        return !config.useWhatsApp() || !config.whatsapp().templateHeadsUp().isEmpty();
    }

    @Override
    public boolean notifyTokenIssued(String phone, String clinicName, int tokenNumber, String slug, UUID tokenId) {
        if (!config.useWhatsApp()) {
            log.info("[notifier stub] token issued -> #{} at {}: {}", tokenNumber, clinicName, trackingUrl(slug, tokenId));
            return true;
        }

        // Meta's template review rejects a raw URL as a body variable and reads
        // the word "token" as an auth code, so the template carries only the
        // number. The tracking link reaches the patient via the desk QR code.
        return safely("token-issued notification", () ->
                whatsapp.sendTemplate(phone, config.whatsapp().templateTokenIssued(), List.of(String.valueOf(tokenNumber))));
    }

    @Override
    public boolean notifyYourTurn(String phone, String clinicName, int tokenNumber, Integer currentTokenNumber) {
        if (!config.useWhatsApp()) {
            log.info("[notifier stub] you're next -> #{}, now serving #{}", tokenNumber, currentTokenNumber);
            return true;
        }

        // The business name cannot be a template variable, so it is baked into
        // the template text rather than passed in.
        return safely("your-turn notification", () ->
                whatsapp.sendTemplate(phone, config.whatsapp().templateYourTurn(),
                        List.of(String.valueOf(currentTokenNumber), String.valueOf(tokenNumber))));
    }

    @Override
    public boolean notifyHeadsUp(String phone, String clinicName, int tokenNumber, int ahead) {
        if (!config.useWhatsApp()) {
            log.info("[notifier stub] heads up -> #{}, {} ahead at {}", tokenNumber, ahead, clinicName);
            return true;
        }

        if (config.whatsapp().templateHeadsUp().isEmpty()) {
            log.debug("heads-up template not configured, skipping #{}", tokenNumber);
            return false;
        }

        return safely("heads-up notification", () ->
                whatsapp.sendTemplate(phone, config.whatsapp().templateHeadsUp(),
                        List.of(String.valueOf(tokenNumber), String.valueOf(ahead))));
    }

    @Override
    public boolean replyToPatient(String phone, String body) {
        if (!config.useWhatsApp()) {
            log.info("[notifier stub] reply -> {}", body);
            return true;
        }
        return safely("whatsapp reply", () -> whatsapp.sendText(phone, body));
    }

    private interface Send {
        void run() throws Exception;
    }

    private static boolean safely(String label, Send send) {
        try {
            send.run();
            return true;
        } catch (Exception error) {
            log.error("{} failed: {}", label, error.getMessage());
            return false;
        }
    }
}
