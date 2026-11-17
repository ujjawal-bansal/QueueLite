package com.queuelite.reminder;

import static org.assertj.core.api.Assertions.assertThat;

import com.queuelite.queue.Token;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ReminderRulesTest {

    static Token token(int number, String status, boolean turnSent, boolean headsUpSent) {
        OffsetDateTime sent = OffsetDateTime.parse("2026-08-28T05:00:00Z");
        return new Token(UUID.randomUUID(), UUID.randomUUID(), number, "P" + number, "9800000000", status,
                sent, null, null, null, null, null, null, null, headsUpSent ? sent : null, turnSent ? sent : null);
    }

    static List<String> describe(List<ReminderService.Due> due) {
        return due.stream().map(item -> item.kind() + ":" + item.token().tokenNumber()).toList();
    }

    @Test
    void theFrontIsToldTheyAreNextAndTheNextFewGetAHeadsUp() {
        List<Token> tokens = new ArrayList<>();
        for (int number = 1; number <= 8; number++) {
            tokens.add(token(number, "waiting", false, false));
        }
        assertThat(describe(ReminderService.findDue(tokens, 3)))
                .containsExactly("your_turn:1", "heads_up:2", "heads_up:3", "heads_up:4");
    }

    @Test
    void anAlreadySentReminderIsNotRepeated() {
        List<Token> tokens = List.of(token(1, "waiting", true, true), token(2, "waiting", false, true),
                token(3, "waiting", false, false));
        assertThat(describe(ReminderService.findDue(tokens, 3))).containsExactly("heads_up:3");
    }

    @Test
    void doneAndNoShowTokensDoNotHoldAnyoneBackAPlace() {
        List<Token> tokens = List.of(token(1, "done", false, false), token(2, "no_show", false, false),
                token(3, "in_progress", false, false), token(4, "waiting", false, false));
        assertThat(describe(ReminderService.findDue(tokens, 3))).containsExactly("your_turn:4");
    }

    @Test
    void aLeadOfZeroLeavesOnlyTheTurnNotification() {
        List<Token> tokens = List.of(token(1, "waiting", false, false), token(2, "waiting", false, false));
        assertThat(describe(ReminderService.findDue(tokens, 0))).containsExactly("your_turn:1");
    }

    @Test
    void anEmptyQueueIsDueNothing() {
        assertThat(ReminderService.findDue(List.of(), 3)).isEmpty();
    }
}
