package com.queuelite;

import static org.assertj.core.api.Assertions.assertThat;

import com.queuelite.support.Api;
import com.queuelite.support.ApiTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Only claim a reminder the channel can actually carry. */
class ReminderChannelTest extends ApiTestBase {

    private Api staff;

    @BeforeEach
    void freshDay() {
        resetDay();
        staff = signedIn();
    }

    @Test
    void withNoApprovedHeadsUpTemplateNobodyIsClaimedForOne() {
        notifier.headsUpAvailable = false;
        for (int index = 1; index <= 4; index++) {
            issue(staff, "Patient " + index, "987650000" + index);
        }

        assertThat(notifier.of("heads_up")).isEmpty();
        assertThat(notifier.of("your_turn")).hasSize(1);
        // The front patient's heads-up is closed off with their turn notice;
        // nobody behind them is marked as warned for a message never sent.
        assertThat(staff.get(CLINIC + "/queue/today").data().get("tokens").findValues("heads_up_sent_at").subList(1, 4))
                .allMatch(value -> value.isNull());
        assertThat(staff.get(CLINIC + "/queue/today").data().get("auto_reminders").asBoolean()).isFalse();
    }

    @Test
    void onceTheTemplateIsApprovedTheNudgeGoesOut() {
        notifier.headsUpAvailable = false;
        for (int index = 1; index <= 4; index++) {
            issue(staff, "Patient " + index, "987650000" + index);
        }

        notifier.headsUpAvailable = true;
        staff.post(CLINIC + "/call-next", null);

        assertThat(notifier.of("heads_up")).extracting(message -> message.tokenNumber()).containsExactly(3, 4);
    }

    @Test
    void aSnapshotIsSharedButAStaffActionIsSeenAtOnce() {
        issue(staff, "Patient 1", "9876500001");
        int before = tokens.todayReads();
        staff.get(CLINIC + "/queue/today");
        staff.get(CLINIC + "/queue/today");
        assertThat(tokens.todayReads() - before).isLessThanOrEqualTo(1);

        String id = staff.get(CLINIC + "/queue/today").data().at("/tokens/0/id").asText();
        staff.patch(CLINIC + "/tokens/" + id + "/no-show", null);
        assertThat(staff.get(CLINIC + "/queue/today").data().at("/tokens/0/status").asText()).isEqualTo("no_show");
    }
}
