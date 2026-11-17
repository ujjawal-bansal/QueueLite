package com.queuelite.queue;

import com.queuelite.util.IstTime;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/**
 * The arithmetic of the queue: who is ahead of whom, where a pushed-back
 * patient goes, and how long everyone can expect to wait. Pure functions, no
 * database, so every rule is tested on its own.
 */
public final class QueueRules {

    private QueueRules() {}

    // ---- order ----

    /**
     * Where a token sits in today's queue. Almost always its own number:
     * queue_position is set only for a patient who has been pushed back.
     */
    public static BigDecimal effectivePosition(Token token) {
        return token.queuePosition() != null
                ? token.queuePosition()
                : BigDecimal.valueOf(token.tokenNumber());
    }

    /**
     * Queue order. Token number breaks ties, so two patients deferred to the
     * same spot keep a stable order rather than swapping about between polls.
     */
    public static final Comparator<Token> QUEUE_ORDER =
            Comparator.comparing(QueueRules::effectivePosition).thenComparingInt(Token::tokenNumber);

    public static List<Token> waitingInOrder(List<Token> tokens) {
        return tokens.stream().filter(Token::isWaiting).sorted(QUEUE_ORDER).toList();
    }

    /**
     * Ahead in the queue, which since deferrals exist is no longer the same as
     * "holding a lower token number".
     */
    public static int countPatientsAhead(List<Token> tokens, Token token) {
        return (int) tokens.stream()
                .filter(other -> other.isWaiting()
                        && !Objects.equals(other.id(), token.id())
                        && QUEUE_ORDER.compare(other, token) < 0)
                .count();
    }

    /**
     * Where to place a patient so that {@code places} *more* patients are seen
     * first, counted from where they stand now. Applied to a patient already
     * five back, an absolute placement would move them forwards - the opposite
     * of what "push back" says on the button.
     *
     * Someone not currently waiting (a no-show returning late, or the patient
     * being seen) has nobody ahead to count from, so {@code places} is measured
     * from the front for them.
     *
     * Returns a position strictly between the patient they should follow and
     * the one after. Positions are numeric, so that midpoint always exists.
     */
    public static BigDecimal positionAfter(List<Token> tokens, Token token, int places) {
        List<Token> others = waitingInOrder(tokens).stream()
                .filter(candidate -> !Objects.equals(candidate.id(), token.id()))
                .toList();

        int alreadyAhead = token.isWaiting() ? countPatientsAhead(tokens, token) : 0;

        // Fewer patients waiting than we were asked to skip: put them at the back.
        int anchorIndex = Math.min(alreadyAhead + places, others.size()) - 1;

        if (anchorIndex < 0) {
            return effectivePosition(token);
        }

        BigDecimal anchor = effectivePosition(others.get(anchorIndex));

        if (anchorIndex + 1 >= others.size()) {
            // Last in the queue: a whole step past the back is plenty of room.
            return anchor.add(BigDecimal.ONE);
        }

        BigDecimal follower = effectivePosition(others.get(anchorIndex + 1));
        return anchor.add(follower).divide(BigDecimal.valueOf(2)).stripTrailingZeros();
    }

    public record Context(Integer currentTokenNumber, int waitingCount) {}

    public static Context context(List<Token> tokens) {
        Integer current = tokens.stream()
                .filter(token -> Token.IN_PROGRESS.equals(token.status()))
                .map(Token::tokenNumber)
                .findFirst()
                .orElse(null);
        int waiting = (int) tokens.stream().filter(Token::isWaiting).count();
        return new Context(current, waiting);
    }

    // ---- pace ----

    // A gap this long is a lunch break or the doctor stepping into surgery, not
    // a consultation.
    static final double MAX_CREDIBLE_GAP_MINUTES = 40;
    static final double MIN_CREDIBLE_GAP_MINUTES = 0.5;
    // Enough samples to be stable, few enough to track how the clinic is
    // running right now rather than three hours ago.
    static final int PACE_SAMPLE_SIZE = 12;

    /**
     * The gaps between consecutive call-ins, in minutes. This, not the length
     * of a consultation, is what predicts a wait: it already contains the
     * turnaround between patients.
     */
    public static List<Double> callInGaps(List<Instant> calledInAt) {
        List<Instant> sorted = calledInAt.stream().filter(Objects::nonNull).sorted().toList();
        List<Double> gaps = new ArrayList<>();

        for (int index = 1; index < sorted.size(); index++) {
            double minutes = Duration.between(sorted.get(index - 1), sorted.get(index)).toMillis() / 60000.0;
            if (minutes >= MIN_CREDIBLE_GAP_MINUTES && minutes <= MAX_CREDIBLE_GAP_MINUTES) {
                gaps.add(minutes);
            }
        }

        return gaps;
    }

    public static List<Double> callInGapsOf(List<Token> tokens) {
        return callInGaps(tokens.stream()
                .map(Token::calledInAt)
                .filter(Objects::nonNull)
                .map(OffsetDateTime::toInstant)
                .toList());
    }

    public static double median(List<Double> values) {
        List<Double> sorted = values.stream().sorted().toList();
        int middle = sorted.size() / 2;
        return sorted.size() % 2 == 0
                ? (sorted.get(middle - 1) + sorted.get(middle)) / 2
                : sorted.get(middle);
    }

    public static double roundToTenth(double value) {
        return BigDecimal.valueOf(value).setScale(1, RoundingMode.HALF_UP).doubleValue();
    }

    public record History(double minutesPerPatient, int samples, int days) {}

    public record Pace(double minutesPerPatient, boolean measured, String source, int samples) {}

    /**
     * How many minutes a patient takes, and where that number came from:
     *
     *   clinic   - the clinic's own figure, while measuring is switched off
     *   today    - the median of the last dozen call-in gaps, once there are enough
     *   history  - the same measure over recent days, for the morning before there are
     *   default  - the clinic's figure, for a clinic with no history at all
     */
    public static Pace minutesPerPatient(List<Token> tokens, Clinic clinic, History history,
                                         boolean useMeasuredPace, double fallbackMinutes) {
        double configured = clinic != null && clinic.avgConsultMinutes() != null && clinic.avgConsultMinutes() > 0
                ? clinic.avgConsultMinutes()
                : fallbackMinutes;

        if (!useMeasuredPace) {
            return new Pace(configured, false, "clinic", 0);
        }

        List<Double> gaps = callInGapsOf(tokens);

        // Three samples is where the median stops being one arbitrary
        // consultation and starts describing the day.
        if (gaps.size() >= 3) {
            List<Double> recent = gaps.subList(Math.max(0, gaps.size() - PACE_SAMPLE_SIZE), gaps.size());
            return new Pace(roundToTenth(median(recent)), true, "today", recent.size());
        }

        if (history != null && history.minutesPerPatient() > 0) {
            return new Pace(history.minutesPerPatient(), true, "history", history.samples());
        }

        return new Pace(configured, false, "default", gaps.size());
    }

    // ---- estimates ----

    /**
     * When a patient with {@code ahead} people in front is likely to be called.
     * The patient page turns this into a clock time, which is far easier to act
     * on than "roughly 340 minutes".
     */
    public static Instant estimateReadyAt(int ahead, double minutesPerPatient, Instant now) {
        if (ahead < 0) {
            return null;
        }
        return now.plusMillis(Math.round(ahead * minutesPerPatient * 60000));
    }

    // Every clinic runs a little past its posted hours. Warning someone whose
    // estimate is nine minutes over would frighten them out of a visit that
    // will happen fine.
    static final Duration CLOSING_GRACE = Duration.ofMinutes(30);

    /**
     * Whether an estimate has run well past closing time. Telling patient #95
     * "around 1:35 am" is worse than telling them nothing: it hides the thing
     * they need to know, which is that today's queue is longer than today.
     */
    public static boolean isAfterClosing(Instant estimate, Clinic clinic, Instant now) {
        if (estimate == null || clinic == null) {
            return false;
        }
        Instant closing = IstTime.instantToday(clinic.closesAt(), now);
        return closing != null && estimate.isAfter(closing.plus(CLOSING_GRACE));
    }
}
