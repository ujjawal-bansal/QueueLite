package com.queuelite.queue;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.queuelite.config.AppConfig;
import com.queuelite.notifier.Notifier;
import com.queuelite.reminder.ReminderService;
import com.queuelite.web.ApiException;
import com.queuelite.web.ApiResponse;
import com.queuelite.web.RateLimited;
import com.queuelite.web.RateLimiter.Budget;
import com.queuelite.web.Requests;
import com.queuelite.web.StaffOnly;
import java.time.Instant;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class ClinicsController {

    private static final Logger log = LoggerFactory.getLogger(ClinicsController.class);
    private static final Pattern TEN_DIGITS = Pattern.compile("^\\d{10}$");
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};

    private final AppConfig config;
    private final QueueService queue;
    private final TokenRepository tokens;
    private final ClinicResolver clinics;
    private final Notifier notifier;
    private final ReminderService reminders;
    private final ObjectMapper json;

    public ClinicsController(AppConfig config, QueueService queue, TokenRepository tokens, ClinicResolver clinics,
                             Notifier notifier, ReminderService reminders, ObjectMapper json) {
        this.config = config;
        this.queue = queue;
        this.tokens = tokens;
        this.clinics = clinics;
        this.notifier = notifier;
        this.reminders = reminders;
        this.json = json;
    }

    // ---- public ----

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("clinic_slug", config.clinicSlug());
        data.put("notifier", config.notifier());
        data.put("time", queue.now().toString());

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("success", true);
        body.put("message", "QueueLite running");
        body.put("data", data);
        return body;
    }

    @GetMapping("/clinic")
    @RateLimited(Budget.PUBLIC)
    public ApiResponse<Clinic.Public> clinic() {
        return ApiResponse.ok(clinics.configured().toPublic());
    }

    /**
     * The waiting-room board. Public and unauthenticated, so it carries no
     * names and no phone numbers - only numbers and counts. Token numbers run
     * 1, 2, 3..., which is exactly why nothing here identifies anybody.
     */
    @GetMapping("/clinics/{slug}/board")
    @RateLimited(Budget.PUBLIC)
    public ApiResponse<Map<String, Object>> board(@PathVariable String slug,
                                                  @RequestParam(name = "token", required = false) String token) {
        Clinic clinic = clinics.resolve(slug);
        QueueState state = queue.state(clinic, false);

        Map<String, Object> board = new LinkedHashMap<>();
        board.put("clinic", clinic.toPublic());
        board.put("current_token_number", state.currentTokenNumber());
        board.put("waiting_count", state.waitingCount());
        board.put("seen_count", state.seenCount());
        board.put("minutes_per_patient", state.minutesPerPatient());
        board.put("pace_measured", state.paceMeasured());
        // The last few called, so someone glancing up can tell the queue is
        // moving rather than stuck.
        board.put("recently_called", state.tokens().stream()
                .filter(candidate -> candidate.calledInAt() != null)
                .sorted(Comparator.comparing(Token::calledInAt).reversed())
                .limit(5)
                .map(Token::tokenNumber)
                .toList());

        // Optional lookup: "I was told I am number 47."
        Long requested = Requests.wholeNumber(token);

        if (requested != null && requested > 0) {
            Token found = state.tokens().stream()
                    .filter(candidate -> candidate.tokenNumber() == requested)
                    .findFirst()
                    .orElse(null);

            Map<String, Object> lookup = new LinkedHashMap<>();

            if (found == null) {
                lookup.put("token_number", requested);
                lookup.put("found", false);
            } else {
                int ahead = QueueRules.countPatientsAhead(state.tokens(), found);
                Instant readyAt = found.isWaiting()
                        ? QueueRules.estimateReadyAt(ahead, state.minutesPerPatient(), queue.now())
                        : null;

                lookup.put("token_number", found.tokenNumber());
                lookup.put("found", true);
                lookup.put("status", found.status());
                lookup.put("patients_ahead", ahead);
                lookup.put("estimated_ready_at", readyAt);
                lookup.put("estimate_after_closing", QueueRules.isAfterClosing(readyAt, clinic, queue.now()));
            }

            board.put("lookup", lookup);
        }

        return ApiResponse.ok(board);
    }

    /**
     * A patient's tracking page. Reachable by anyone holding the link - the
     * unguessable token id is the capability - so it never returns a phone number.
     */
    @GetMapping("/clinics/{slug}/tokens/{tokenId}")
    @RateLimited(Budget.PUBLIC)
    public ApiResponse<Map<String, Object>> token(@PathVariable String slug, @PathVariable String tokenId) {
        UUID id = Requests.uuid(tokenId, "Token not found");
        Clinic clinic = clinics.resolve(slug);
        QueueState state = queue.state(clinic, false);

        // Already in the snapshot the whole waiting room shares, so reading it
        // from there costs nothing. Only a link to another day's token needs
        // its own lookup.
        Token token = state.tokens().stream()
                .filter(candidate -> candidate.id().equals(id))
                .findFirst()
                .or(() -> tokens.findById(clinic.id(), id))
                .orElseThrow(() -> ApiException.notFound("Token not found"));

        int ahead = QueueRules.countPatientsAhead(state.tokens(), token);
        Instant readyAt = token.isWaiting()
                ? QueueRules.estimateReadyAt(ahead, state.minutesPerPatient(), queue.now())
                : null;

        Map<String, Object> publicToken = new LinkedHashMap<>();
        publicToken.put("id", token.id());
        publicToken.put("token_number", token.tokenNumber());
        publicToken.put("patient_name", token.patientName());
        publicToken.put("status", token.status());
        publicToken.put("created_at", token.createdAt());
        publicToken.put("called_in_at", token.calledInAt());

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("token", publicToken);
        data.put("clinic", clinic.toPublic());
        data.put("current_token_number", state.currentTokenNumber());
        data.put("waiting_count", state.waitingCount());
        data.put("patients_ahead", ahead);
        data.put("minutes_per_patient", state.minutesPerPatient());
        data.put("pace_measured", state.paceMeasured());
        data.put("estimated_ready_at", readyAt);
        data.put("estimate_after_closing", QueueRules.isAfterClosing(readyAt, clinic, queue.now()));
        return ApiResponse.ok(data);
    }

    // ---- staff ----

    @GetMapping("/clinics/{slug}/queue/today")
    @StaffOnly
    public ApiResponse<Map<String, Object>> today(@PathVariable String slug) {
        Clinic clinic = clinics.resolve(slug);
        QueueState state = queue.state(clinic, false);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("tokens", state.tokens());
        data.put("clinic", clinic.toPublic());
        data.put("current_token_number", state.currentTokenNumber());
        data.put("waiting_count", state.waitingCount());
        data.put("seen_count", state.seenCount());
        data.put("no_show_count", state.noShowCount());
        data.put("total_today", state.totalToday());
        data.put("minutes_per_patient", state.minutesPerPatient());
        data.put("pace_measured", state.paceMeasured());
        // The desk repeats this figure to patients, so it is told where the
        // figure came from.
        data.put("pace_source", state.paceSource());
        data.put("reminder_lead_patients", config.reminderLeadPatients());
        // Configured is not the same as deliverable.
        data.put("auto_reminders", notifier.canSendHeadsUp());
        return ApiResponse.ok(data);
    }

    @PostMapping("/clinics/{slug}/tokens")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ResponseEntity<ApiResponse<Map<String, Object>>> createToken(
            @PathVariable String slug, @RequestBody(required = false) JsonNode body) {
        String name = Requests.text(body, "patient_name");
        String phone = Requests.text(body, "patient_phone");

        if (name.length() < 2 || name.length() > 80) {
            throw ApiException.badRequest("patient_name must be between 2 and 80 characters");
        }
        if (!TEN_DIGITS.matcher(phone).matches()) {
            throw ApiException.badRequest("patient_phone must be exactly 10 digits");
        }

        Clinic clinic = clinics.resolve(slug);

        // Issued here rather than by a stored function. Correctness under two
        // entries landing together comes from the unique index on (clinic,
        // day, number): a collision means somebody else took the number in
        // between, so read again and take the next one. Five attempts covers
        // any realistic collision at one front desk.
        Token token = null;
        for (int attempt = 0; token == null; attempt++) {
            try {
                token = tokens.insert(clinic.id(), queue.nextTokenNumber(clinic.id()), name, phone,
                        queue.today(), queue.now());
            } catch (DuplicateKeyException collision) {
                if (attempt >= 4) {
                    throw ApiException.badRequest("Could not allocate a token number. Please try again.");
                }
                log.warn("token number collided, taking the next attempt={}", attempt + 1);
            }
        }

        queue.invalidate(clinic.id());
        log.info("token issued tokenNumber={}", token.tokenNumber());

        QueueState state = queue.state(clinic, true);
        int ahead = QueueRules.countPatientsAhead(state.tokens(), token);
        Instant readyAt = QueueRules.estimateReadyAt(ahead, state.minutesPerPatient(), queue.now());

        boolean notified = notifier.notifyTokenIssued(phone, clinic.name(), token.tokenNumber(), clinic.slug(), token.id());

        Map<String, Object> data = json.convertValue(token, MAP);
        data.put("tracking_url", notifier.trackingUrl(clinic.slug(), token.id()));
        data.put("patients_ahead", ahead);
        data.put("estimated_ready_at", readyAt);
        // Worth knowing at the counter, while the patient is still standing
        // there and can be told to come back tomorrow instead.
        data.put("estimate_after_closing", QueueRules.isAfterClosing(readyAt, clinic, queue.now()));
        data.put("notified", notified && notifier.isWhatsAppEnabled());

        // Someone joining an empty or nearly empty queue is immediately due
        // their reminder.
        reminders.runInBackground(clinic);

        return ResponseEntity.status(HttpStatus.CREATED).body(ApiResponse.ok(data));
    }

    @PatchMapping("/clinics/{slug}/tokens/{tokenId}/call-in")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ApiResponse<Token> callIn(@PathVariable String slug, @PathVariable String tokenId) {
        UUID id = Requests.uuid(tokenId, "Token not found");
        Clinic clinic = clinics.resolve(slug);
        Token token = callInById(clinic, id);

        // Everyone behind just moved up one, which is what decides who is now
        // due a reminder.
        reminders.runInBackground(clinic);
        return ApiResponse.ok(token);
    }

    /**
     * Calls in whoever is at the front. With a hundred tokens on the screen,
     * hunting for the right row is the slowest thing the desk does.
     */
    @PostMapping("/clinics/{slug}/call-next")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ApiResponse<Token> callNext(@PathVariable String slug) {
        Clinic clinic = clinics.resolve(slug);
        Token front = queue.nextWaiting(clinic.id())
                .orElseThrow(() -> new ApiException(HttpStatus.CONFLICT, "Nobody is waiting"));
        Token token = callInById(clinic, front.id());

        reminders.runInBackground(clinic);
        return ApiResponse.ok(token);
    }

    /**
     * Puts a patient back in the queue, a chosen number of patients later.
     * Works from any status: "see this person after three more patients" makes
     * sense whether they are waiting, mid-call, or were written off earlier.
     */
    @PatchMapping("/clinics/{slug}/tokens/{tokenId}/push-back")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ApiResponse<Token> pushBack(@PathVariable String slug, @PathVariable String tokenId,
                                       @RequestBody(required = false) JsonNode body) {
        UUID id = Requests.uuid(tokenId, "Token not found");
        Long places = Requests.wholeNumber(body == null ? null : body.get("places"));

        if (places == null || places < 1 || places > 50) {
            throw ApiException.badRequest("places must be a whole number between 1 and 50");
        }

        Clinic clinic = clinics.resolve(slug);
        QueueState state = queue.state(clinic, true);
        Token token = state.tokens().stream()
                .filter(candidate -> candidate.id().equals(id))
                .findFirst()
                .orElseThrow(() -> ApiException.notFound("Token not found"));

        Token updated = tokens.pushBack(clinic.id(), id,
                        QueueRules.positionAfter(state.tokens(), token, places.intValue()))
                .orElseThrow(() -> ApiException.notFound("Token not found"));

        queue.invalidate(clinic.id());
        log.info("token pushed back in the queue tokenNumber={} places={}", updated.tokenNumber(), places);

        reminders.runInBackground(clinic);
        return ApiResponse.ok(updated);
    }

    @PatchMapping("/clinics/{slug}/tokens/{tokenId}/done")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ApiResponse<Token> done(@PathVariable String slug, @PathVariable String tokenId) {
        return setStatus(slug, tokenId, Token.DONE, "token completed");
    }

    @PatchMapping("/clinics/{slug}/tokens/{tokenId}/no-show")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ApiResponse<Token> noShow(@PathVariable String slug, @PathVariable String tokenId) {
        return setStatus(slug, tokenId, Token.NO_SHOW, "token marked no-show");
    }

    /**
     * Call In and No Show sit next to each other on a phone, so a mis-tap is
     * easy and was previously unrecoverable.
     */
    @PatchMapping("/clinics/{slug}/tokens/{tokenId}/restore")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ApiResponse<Token> restore(@PathVariable String slug, @PathVariable String tokenId) {
        return setStatus(slug, tokenId, Token.WAITING, "token returned to the queue");
    }

    private ApiResponse<Token> setStatus(String slug, String tokenId, String status, String logMessage) {
        UUID id = Requests.uuid(tokenId, "Token not found");
        Clinic clinic = clinics.resolve(slug);

        Token token = tokens.setStatus(clinic.id(), id, status, queue.now())
                .orElseThrow(() -> ApiException.notFound("Token not found"));

        queue.invalidate(clinic.id());
        log.info("{} tokenNumber={}", logMessage, token.tokenNumber());

        // Finishing a visit or dropping a no-show pulls everyone behind forward.
        reminders.runInBackground(clinic);
        return ApiResponse.ok(token);
    }

    /** Moves a token to in_progress, closing out whoever was being seen. */
    private Token callInById(Clinic clinic, UUID tokenId) {
        // Confirm the token belongs to this clinic before closing anyone out, so
        // a bad id cannot end the visit of whoever is currently being seen.
        if (tokens.findById(clinic.id(), tokenId).isEmpty()) {
            throw ApiException.notFound("Token not found");
        }

        Token token = tokens.callIn(clinic.id(), tokenId, queue.today(), queue.now())
                .filter(found -> Objects.nonNull(found.id()))
                .orElseThrow(() -> ApiException.notFound("Token not found"));

        queue.invalidate(clinic.id());
        log.info("token called in tokenNumber={}", token.tokenNumber());
        return token;
    }

}
