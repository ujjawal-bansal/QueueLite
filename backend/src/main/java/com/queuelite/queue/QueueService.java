package com.queuelite.queue;

import com.queuelite.config.AppConfig;
import com.queuelite.util.IstTime;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class QueueService {

    private static final Logger log = LoggerFactory.getLogger(QueueService.class);

    // A full waiting room polls its tracking pages roughly 700 times a minute,
    // and every one of those reads needs the same answer: today's tokens.
    // Serving them from one short-lived snapshot turns that into ~24 database
    // reads a minute. Two and a half seconds is under the poll interval, so
    // nobody sees a stale queue for longer than one refresh.
    static final Duration SNAPSHOT_TTL = Duration.ofMillis(2500);

    // A clinic's pace changes over weeks, not minutes.
    static final int HISTORY_DAYS = 7;
    static final Duration HISTORY_TTL = Duration.ofHours(1);

    private final TokenRepository tokens;
    private final AppConfig config;
    private final Clock clock;

    /**
     * One entry per clinic. Holding the in-flight future is what makes
     * concurrent callers share a single query instead of each starting their own.
     */
    private final Map<UUID, Snapshot> snapshots = new ConcurrentHashMap<>();
    private final Map<UUID, CachedHistory> paceHistory = new ConcurrentHashMap<>();

    private static final class Snapshot {
        final CompletableFuture<List<Token>> future = new CompletableFuture<>();
        volatile boolean pending = true;
        volatile long fetchedAt;
    }

    private record CachedHistory(QueueRules.History value, long fetchedAt) {}

    public QueueService(TokenRepository tokens, AppConfig config, Clock clock) {
        this.tokens = tokens;
        this.config = config;
        this.clock = clock;
    }

    public Optional<Clinic> findClinic(String slug) {
        return tokens.findClinicBySlug(slug);
    }

    public Instant now() {
        return clock.instant();
    }

    public LocalDate today() {
        return IstTime.today(clock.instant());
    }

    /** Staff mutations call this, so the desk never reads its own stale write. */
    public void invalidate(UUID clinicId) {
        snapshots.remove(clinicId);
    }

    /**
     * Today's tokens, shared across every concurrent reader for a moment.
     * {@code fresh} bypasses the snapshot - for anything that decides who is
     * called or messaged, where acting on a stale front skips a real patient.
     */
    public List<Token> todayTokens(UUID clinicId, boolean fresh) {
        Snapshot snapshot;
        boolean owner = false;

        synchronized (snapshots) {
            Snapshot cached = snapshots.get(clinicId);
            long now = clock.millis();

            if (!fresh && cached != null
                    && (cached.pending || now - cached.fetchedAt < SNAPSHOT_TTL.toMillis())) {
                // Still warm, or still loading: either way this caller joins it.
                snapshot = cached;
            } else {
                snapshot = new Snapshot();
                snapshot.fetchedAt = now;
                snapshots.put(clinicId, snapshot);
                owner = true;
            }
        }

        if (owner) {
            try {
                List<Token> result = List.copyOf(tokens.findForDay(clinicId, today()));
                snapshot.fetchedAt = clock.millis();
                snapshot.pending = false;
                snapshot.future.complete(result);
            } catch (RuntimeException error) {
                // A failed read must not be cached, or one blip freezes the
                // queue for everyone until the TTL expires.
                snapshots.remove(clinicId, snapshot);
                snapshot.future.completeExceptionally(error);
            }
        }

        try {
            return snapshot.future.join();
        } catch (CompletionException error) {
            if (error.getCause() instanceof RuntimeException cause) {
                throw cause;
            }
            throw error;
        }
    }

    public QueueState state(Clinic clinic, boolean fresh) {
        List<Token> today = todayTokens(clinic.id(), fresh);
        QueueRules.Context context = QueueRules.context(today);

        // Only worth reading history while measuring is on and today cannot
        // answer for itself, which is the first few patients of the morning.
        boolean needsHistory = config.useMeasuredPace() && QueueRules.callInGapsOf(today).size() < 3;
        QueueRules.History history = needsHistory ? historicalPace(clinic.id()) : null;
        QueueRules.Pace pace = QueueRules.minutesPerPatient(
                today, clinic, history, config.useMeasuredPace(), config.avgConsultMinutes());

        return new QueueState(
                today,
                context.currentTokenNumber(),
                context.waitingCount(),
                pace.minutesPerPatient(),
                pace.measured(),
                pace.source(),
                pace.samples(),
                today.size(),
                (int) today.stream().filter(token -> Token.DONE.equals(token.status())).count(),
                (int) today.stream().filter(token -> Token.NO_SHOW.equals(token.status())).count());
    }

    /**
     * The number the next patient should be given today, read through the same
     * path everything else uses so it is allocated against exactly the set the
     * queue will show. The unique index is the guarantee; the caller retries.
     */
    public int nextTokenNumber(UUID clinicId) {
        return todayTokens(clinicId, true).stream().mapToInt(Token::tokenNumber).max().orElse(0) + 1;
    }

    public Optional<Token> nextWaiting(UUID clinicId) {
        return QueueRules.waitingInOrder(todayTokens(clinicId, true)).stream().findFirst();
    }

    /**
     * A patient's live token for today by phone number, so an inbound WhatsApp
     * message can be answered without the patient quoting an id. Matches on the
     * last 10 digits, since WhatsApp delivers numbers in E.164.
     */
    public Optional<Token> findActiveByPhone(UUID clinicId, String phone) {
        String digits = phone == null ? "" : phone.replaceAll("\\D", "");
        if (digits.length() < 10) {
            return Optional.empty();
        }
        String last10 = digits.substring(digits.length() - 10);

        return todayTokens(clinicId, false).stream()
                .filter(Token::isActive)
                .filter(token -> token.patientPhone() != null
                        && token.patientPhone().replaceAll("\\D", "").endsWith(last10))
                .findFirst();
    }

    /**
     * What this clinic's pace has looked like recently. Exists for the first
     * hour of the day, before today has enough call-ins to measure.
     */
    QueueRules.History historicalPace(UUID clinicId) {
        CachedHistory cached = paceHistory.get(clinicId);
        long now = clock.millis();

        if (cached != null && now - cached.fetchedAt() < HISTORY_TTL.toMillis()) {
            return cached.value();
        }

        QueueRules.History value = fetchHistoricalPace(clinicId);
        paceHistory.put(clinicId, new CachedHistory(value, now));
        return value;
    }

    private QueueRules.History fetchHistoricalPace(UUID clinicId) {
        Instant start = IstTime.todayUtcRange(clock.instant()).start();
        List<TokenRepository.CallIn> callIns;

        try {
            callIns = tokens.callInsBetween(clinicId, start.minus(Duration.ofDays(HISTORY_DAYS)), start);
        } catch (RuntimeException error) {
            // A wait estimate is not worth failing a request over; the caller
            // falls back to the clinic's configured figure.
            log.error("pace history read failed: {}", error.getMessage());
            return null;
        }

        // Gaps are computed within a day, never across the overnight break -
        // otherwise every night counts as one enormous consultation.
        Map<LocalDate, List<Instant>> byDay = new LinkedHashMap<>();
        for (TokenRepository.CallIn callIn : callIns) {
            byDay.computeIfAbsent(IstTime.today(callIn.createdAt()), day -> new ArrayList<>())
                    .add(callIn.calledInAt());
        }

        List<Double> gaps = byDay.values().stream()
                .flatMap(day -> QueueRules.callInGaps(day).stream())
                .toList();

        if (gaps.size() < 10) {
            return null;
        }

        return new QueueRules.History(QueueRules.roundToTenth(QueueRules.median(gaps)), gaps.size(), byDay.size());
    }
}
