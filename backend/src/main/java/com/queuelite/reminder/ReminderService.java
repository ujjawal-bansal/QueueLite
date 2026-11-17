package com.queuelite.reminder;

import com.queuelite.config.AppConfig;
import com.queuelite.config.BackgroundTasks;
import com.queuelite.notifier.Notifier;
import com.queuelite.queue.Clinic;
import com.queuelite.queue.QueueRules;
import com.queuelite.queue.QueueService;
import com.queuelite.queue.QueueState;
import com.queuelite.queue.Token;
import com.queuelite.queue.TokenRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Position decides who hears from the clinic, not which button staff pressed:
 *
 *   heads_up   - inside the lead window, "start heading over"
 *   your_turn  - nothing left ahead of them, "you're next"
 *
 * Both are keyed to position, so a no-show, an undo, or three patients called
 * in quickly all produce the right messages without any of those paths
 * knowing about reminders.
 */
@Service
public class ReminderService {

    private static final Logger log = LoggerFactory.getLogger(ReminderService.class);

    public static final String YOUR_TURN = "your_turn";
    public static final String HEADS_UP = "heads_up";

    public record Due(Token token, String kind, int ahead) {}

    public record Result(int sent, int due) {}

    private final QueueService queue;
    private final TokenRepository tokens;
    private final Notifier notifier;
    private final AppConfig config;
    private final BackgroundTasks background;

    public ReminderService(QueueService queue, TokenRepository tokens, Notifier notifier, AppConfig config,
                           BackgroundTasks background) {
        this.queue = queue;
        this.tokens = tokens;
        this.notifier = notifier;
        this.config = config;
        this.background = background;
    }

    /** Who is due a reminder right now, in queue order rather than token order. */
    public static List<Due> findDue(List<Token> today, int leadPatients) {
        List<Token> waiting = QueueRules.waitingInOrder(today);
        List<Due> due = new ArrayList<>();

        for (int index = 0; index < waiting.size(); index++) {
            Token token = waiting.get(index);

            // index is exactly how many waiting patients sit in front of this one.
            if (index == 0) {
                if (token.turnNotifiedAt() == null) {
                    due.add(new Due(token, YOUR_TURN, 0));
                }
                continue;
            }

            if (leadPatients > 0 && index <= leadPatients && token.headsUpSentAt() == null) {
                due.add(new Due(token, HEADS_UP, index));
            }
        }

        return due;
    }

    /**
     * Brings reminders up to date with the queue as it now stands. Reads fresh:
     * it runs straight after a mutation, and acting on a snapshot from before
     * that mutation would message the wrong patient.
     */
    public Result run(Clinic clinic) {
        QueueState state = queue.state(clinic, true);

        // Drop what the channel cannot carry before claiming any of it.
        List<Due> due = findDue(state.tokens(), config.reminderLeadPatients()).stream()
                .filter(item -> !item.kind().equals(HEADS_UP) || notifier.canSendHeadsUp())
                .toList();

        if (due.isEmpty()) {
            return new Result(0, 0);
        }

        List<CompletableFuture<Boolean>> sends = due.stream()
                .map(item -> CompletableFuture.supplyAsync(
                        () -> send(clinic, item, state.currentTokenNumber()), background))
                .toList();

        int sent = (int) sends.stream().map(CompletableFuture::join).filter(Boolean::booleanValue).count();

        // The claims changed rows the desk shows ("Reminded"), so the shared
        // snapshot taken before them is out of date.
        queue.invalidate(clinic.id());

        log.info("queue reminders processed due={} sent={} kinds={}", due.size(), sent,
                due.stream().map(Due::kind).toList());

        return new Result(sent, due.size());
    }

    /**
     * Same, but never on the request's critical path. Awaiting up to four
     * WhatsApp sends would put that delay on every Call In tap.
     */
    public void runInBackground(Clinic clinic) {
        background.execute(() -> {
            try {
                run(clinic);
            } catch (RuntimeException error) {
                log.error("reminder pass failed: {}", error.getMessage());
            }
        });
    }

    private boolean send(Clinic clinic, Due item, Integer currentTokenNumber) {
        Token token = item.token();

        // Claim before sending. The message is the side effect that cannot be
        // taken back, so losing the race must mean sending nothing.
        if (!claim(token, item.kind())) {
            return false;
        }

        if (item.kind().equals(YOUR_TURN)) {
            // Someone who is next will never need the earlier nudge; claiming it
            // too stops a restore-then-recall from doubling back and sending one.
            claim(token, HEADS_UP);
        }

        boolean delivered = item.kind().equals(YOUR_TURN)
                ? notifier.notifyYourTurn(token.patientPhone(), clinic.name(), token.tokenNumber(), currentTokenNumber)
                : notifier.notifyHeadsUp(token.patientPhone(), clinic.name(), token.tokenNumber(), item.ahead());

        if (!delivered) {
            // Hand the claim back so the next queue movement tries again. Losing
            // a patient's only notification is worse than one duplicate.
            try {
                tokens.releaseReminder(token.id(), item.kind());
            } catch (RuntimeException error) {
                log.error("reminder release failed kind={}: {}", item.kind(), error.getMessage());
            }
            log.warn("reminder send failed, will retry on the next queue change token={} kind={}",
                    token.tokenNumber(), item.kind());
        }

        return delivered;
    }

    // Never let reminder bookkeeping break a staff action: a failed claim
    // means a patient may miss one message, not that the desk sees an error.
    private boolean claim(Token token, String kind) {
        try {
            return tokens.claimReminder(token.id(), kind, queue.now());
        } catch (RuntimeException error) {
            log.error("reminder claim failed kind={}: {}", kind, error.getMessage());
            return false;
        }
    }
}
