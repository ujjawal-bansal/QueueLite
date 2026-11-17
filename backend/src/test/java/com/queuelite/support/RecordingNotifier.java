package com.queuelite.support;

import com.queuelite.notifier.Notifier;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Records what each patient was told, so tests assert on the messages
 * themselves rather than on the queue's bookkeeping. Can fail like an outage.
 */
public class RecordingNotifier implements Notifier {

    public record Sent(String kind, int tokenNumber, Integer other) {}

    public final List<Sent> sent = new CopyOnWriteArrayList<>();
    public volatile boolean deliveryFails = false;
    public volatile boolean headsUpAvailable = true;

    public List<Sent> of(String kind) {
        return sent.stream().filter(message -> message.kind().equals(kind)).toList();
    }

    public void reset() {
        sent.clear();
        deliveryFails = false;
        headsUpAvailable = true;
    }

    @Override
    public boolean notifyTokenIssued(String phone, String clinicName, int tokenNumber, String slug, UUID tokenId) {
        sent.add(new Sent("issued", tokenNumber, null));
        return true;
    }

    @Override
    public boolean notifyYourTurn(String phone, String clinicName, int tokenNumber, Integer currentTokenNumber) {
        if (deliveryFails) {
            return false;
        }
        sent.add(new Sent("your_turn", tokenNumber, currentTokenNumber));
        return true;
    }

    @Override
    public boolean notifyHeadsUp(String phone, String clinicName, int tokenNumber, int ahead) {
        if (deliveryFails) {
            return false;
        }
        sent.add(new Sent("heads_up", tokenNumber, ahead));
        return true;
    }

    @Override
    public boolean replyToPatient(String phone, String body) {
        return true;
    }

    @Override
    public String trackingUrl(String slug, UUID tokenId) {
        return "http://localhost:5173/q/" + slug + "/" + tokenId;
    }

    @Override
    public boolean isWhatsAppEnabled() {
        return true;
    }

    @Override
    public boolean canSendHeadsUp() {
        return headsUpAvailable;
    }
}
