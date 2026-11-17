package com.queuelite.followup;

import com.fasterxml.jackson.databind.JsonNode;
import com.queuelite.queue.Clinic;
import com.queuelite.queue.ClinicResolver;
import com.queuelite.queue.QueueService;
import com.queuelite.queue.Token;
import com.queuelite.queue.TokenRepository;
import com.queuelite.util.IstTime;
import com.queuelite.web.ApiException;
import com.queuelite.web.ApiResponse;
import com.queuelite.web.RateLimited;
import com.queuelite.web.RateLimiter.Budget;
import com.queuelite.web.Requests;
import com.queuelite.web.StaffOnly;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Follow-ups. Staff only: patient names, numbers and the doctor's notes, with
 * no unguessable link standing in for authentication. Nothing here messages a
 * patient; the desk contacts them from the list.
 */
@RestController
@RequestMapping("/api/clinics/{slug}")
public class FollowUpsController {

    private static final Logger log = LoggerFactory.getLogger(FollowUpsController.class);

    // A year is already well past any ophthalmology review interval, and a
    // typo that schedules somebody for 2031 is worse than one that is refused.
    static final int MAX_FOLLOW_UP_DAYS = 365;
    static final int MAX_NOTE_LENGTH = 500;
    // Overdue follow-ups plus the next few weeks. Overdue ones never expire:
    // a patient who did not come back is exactly who the list is for.
    static final int LIST_WITHIN_DAYS = 30;

    private final ClinicResolver clinics;
    private final QueueService queue;
    private final TokenRepository tokens;

    public FollowUpsController(ClinicResolver clinics, QueueService queue, TokenRepository tokens) {
        this.clinics = clinics;
        this.queue = queue;
        this.tokens = tokens;
    }

    /** Records "come back in X days" against today's visit. */
    @PostMapping("/tokens/{tokenId}/follow-up")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ResponseEntity<ApiResponse<FollowUp>> add(@PathVariable String slug, @PathVariable String tokenId,
                                                     @RequestBody(required = false) JsonNode body) {
        UUID id = Requests.uuid(tokenId, "Token not found");
        Long days = Requests.wholeNumber(body == null ? null : body.get("days"));
        String note = Requests.text(body, "note");

        if (days == null || days < 1 || days > MAX_FOLLOW_UP_DAYS) {
            throw ApiException.badRequest("days must be a whole number between 1 and " + MAX_FOLLOW_UP_DAYS);
        }
        if (note.length() > MAX_NOTE_LENGTH) {
            throw ApiException.badRequest("note must be " + MAX_NOTE_LENGTH + " characters or fewer");
        }

        Clinic clinic = clinics.resolve(slug);
        Token token = queue.todayTokens(clinic.id(), false).stream()
                .filter(candidate -> candidate.id().equals(id))
                .findFirst()
                .orElseThrow(() -> ApiException.notFound("Token not found"));

        Token updated = tokens.setFollowUp(token.id(), IstTime.addDays(days, queue.now()), note.isEmpty() ? null : note)
                .orElseThrow(() -> ApiException.notFound("Token not found"));

        queue.invalidate(clinic.id());
        log.info("follow-up scheduled tokenNumber={} days={}", token.tokenNumber(), days);
        return ResponseEntity.status(HttpStatus.CREATED).body(ApiResponse.ok(FollowUp.of(updated)));
    }

    @GetMapping("/follow-ups")
    @StaffOnly
    public ApiResponse<Map<String, List<FollowUp>>> list(@PathVariable String slug) {
        Clinic clinic = clinics.resolve(slug);
        List<FollowUp> followUps = tokens
                .openFollowUps(clinic.id(), IstTime.addDays(LIST_WITHIN_DAYS, queue.now()))
                .stream()
                .map(FollowUp::of)
                .map(followUp -> followUp.withDaysUntil(IstTime.daysUntil(followUp.dueOn(), queue.now())))
                .toList();

        return ApiResponse.ok(Map.of("follow_ups", followUps));
    }

    @PatchMapping("/follow-ups/{followUpId}/done")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ApiResponse<FollowUp> complete(@PathVariable String slug, @PathVariable String followUpId) {
        return setStatus(slug, followUpId, "completed", "follow-up completed");
    }

    @PatchMapping("/follow-ups/{followUpId}/cancel")
    @StaffOnly
    @RateLimited(Budget.WRITE)
    public ApiResponse<FollowUp> cancel(@PathVariable String slug, @PathVariable String followUpId) {
        return setStatus(slug, followUpId, "cancelled", "follow-up cancelled");
    }

    private ApiResponse<FollowUp> setStatus(String slug, String followUpId, String status, String logMessage) {
        UUID id = Requests.uuid(followUpId, "Follow-up not found");
        Clinic clinic = clinics.resolve(slug);

        Token token = tokens.setFollowUpStatus(clinic.id(), id, status)
                .orElseThrow(() -> ApiException.notFound("Follow-up not found"));

        // The follow-up list reads from the same rows as the queue.
        queue.invalidate(clinic.id());
        log.info(logMessage);
        return ApiResponse.ok(FollowUp.of(token));
    }
}
