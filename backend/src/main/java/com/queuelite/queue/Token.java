package com.queuelite.queue;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * One row of {@code tokens}: one patient, one day. Serialised in snake_case,
 * column for column, exactly as the staff desk has always received it.
 */
public record Token(
        UUID id,
        UUID clinicId,
        int tokenNumber,
        String patientName,
        String patientPhone,
        String status,
        OffsetDateTime createdAt,
        LocalDate tokenDay,
        OffsetDateTime calledInAt,
        OffsetDateTime completedAt,
        // Set only for a patient who has been pushed back. Numeric so a patient
        // can always be placed between two others without renumbering anyone.
        BigDecimal queuePosition,
        LocalDate followUpDueOn,
        String followUpNote,
        String followUpStatus,
        OffsetDateTime headsUpSentAt,
        OffsetDateTime turnNotifiedAt) {

    public static final String WAITING = "waiting";
    public static final String IN_PROGRESS = "in_progress";
    public static final String DONE = "done";
    public static final String NO_SHOW = "no_show";

    public boolean isWaiting() {
        return WAITING.equals(status);
    }

    public boolean isActive() {
        return WAITING.equals(status) || IN_PROGRESS.equals(status);
    }
}
