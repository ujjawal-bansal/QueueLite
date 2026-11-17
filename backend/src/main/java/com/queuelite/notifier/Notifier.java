package com.queuelite.notifier;

import java.util.UUID;

/**
 * How patients hear from the clinic.
 *
 * Notifications must never take the queue down with them: a WhatsApp outage
 * should not stop the front desk issuing a token. Every method is therefore
 * best-effort and returns whether the message went out, never throwing.
 */
public interface Notifier {

    boolean notifyTokenIssued(String phone, String clinicName, int tokenNumber, String slug, UUID tokenId);

    boolean notifyYourTurn(String phone, String clinicName, int tokenNumber, Integer currentTokenNumber);

    /** The "start heading over" nudge, sent while a few patients are still ahead. */
    boolean notifyHeadsUp(String phone, String clinicName, int tokenNumber, int ahead);

    /** A free-form reply inside the 24h window the patient opened by messaging us. */
    boolean replyToPatient(String phone, String body);

    String trackingUrl(String slug, UUID tokenId);

    /** Only claim delivery when a real message actually goes out. */
    boolean isWhatsAppEnabled();

    /**
     * Whether the heads-up can actually be delivered. On WhatsApp that needs an
     * approved template; without one the reminder engine skips it rather than
     * marking patients as reminded for a message that was never sent.
     */
    boolean canSendHeadsUp();
}
