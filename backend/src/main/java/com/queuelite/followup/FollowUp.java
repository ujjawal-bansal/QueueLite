package com.queuelite.followup;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.queuelite.queue.Token;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * The doctor's instruction to come back, as the staff list shows it. Stored on
 * the visit it was given at, so the name and number are the ones the desk
 * already checked when the token was issued.
 */
public record FollowUp(
        UUID id,
        int tokenNumber,
        String patientName,
        String patientPhone,
        LocalDate dueOn,
        String note,
        String status,
        OffsetDateTime visitedOn,
        @JsonInclude(JsonInclude.Include.NON_NULL) Long daysUntil) {

    public static FollowUp of(Token token) {
        return new FollowUp(token.id(), token.tokenNumber(), token.patientName(), token.patientPhone(),
                token.followUpDueOn(), token.followUpNote(), token.followUpStatus(), token.createdAt(), null);
    }

    public FollowUp withDaysUntil(long days) {
        return new FollowUp(id, tokenNumber, patientName, patientPhone, dueOn, note, status, visitedOn, days);
    }
}
