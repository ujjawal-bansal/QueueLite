package com.queuelite.queue;

import java.util.List;

/** The day's tokens plus the derived figures, computed once instead of in each caller. */
public record QueueState(
        List<Token> tokens,
        Integer currentTokenNumber,
        int waitingCount,
        double minutesPerPatient,
        boolean paceMeasured,
        String paceSource,
        int paceSamples,
        int totalToday,
        int seenCount,
        int noShowCount) {}
