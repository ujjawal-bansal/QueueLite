package com.queuelite;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.queuelite.support.Api;
import com.queuelite.support.ApiTestBase;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Numbering restarts at 1 every IST midnight, wherever the server runs. */
class DailyNumberingTest extends ApiTestBase {

    private Api staff;

    @BeforeEach
    void freshDay() {
        resetDay();
        staff = signedIn();
    }

    /** Moves the clock, then signs in again: a staff session lasts twelve hours. */
    private void moveTo(Runnable move) {
        move.run();
        staff = signedIn();
    }

    private int issueOne(String name) {
        return issue(staff, name, "9876500000").data().get("token_number").asInt();
    }

    @Test
    void theFirstPatientOfTheDayIsNumberOne() {
        assertThat(issueOne("First")).isEqualTo(1);
    }

    @Test
    void numberingClimbsThroughTheDayWithoutRepeating() {
        for (int expected = 1; expected <= 12; expected++) {
            assertThat(issueOne("Patient " + expected)).isEqualTo(expected);
            clock.advance(Duration.ofMinutes(20));
        }
    }

    @Test
    void aNewDayRestartsAtOneHoweverBusyYesterdayWas() {
        for (int index = 0; index < 30; index++) {
            issueOne("Yesterday " + index);
        }
        moveTo(() -> clock.advance(Duration.ofDays(1)));
        assertThat(issueOne("Today")).isEqualTo(1);
    }

    @Test
    void aTokenIssuedJustAfterIstMidnightStartsTheNewDayAtOne() {
        moveTo(() -> clock.set(Instant.parse("2026-08-28T18:29:00Z"))); // 23:59 IST
        assertThat(issueOne("Late night")).isEqualTo(1);
        assertThat(issueOne("Later night")).isEqualTo(2);

        moveTo(() -> clock.set(Instant.parse("2026-08-28T18:31:00Z"))); // 00:01 IST, the next day
        JsonNode created = issue(staff, "Just after midnight", "9876500001").data();
        assertThat(created.get("token_number").asInt()).isEqualTo(1);
        assertThat(created.get("token_day").asText()).isEqualTo("2026-08-29");
    }

    @Test
    void yesterdaysPatientsAreNotInTodaysQueue() {
        issueOne("Yesterday");
        moveTo(() -> clock.advance(Duration.ofDays(1)));
        JsonNode queue = staff.get(CLINIC + "/queue/today").data();
        assertThat(queue.get("total_today").asInt()).isZero();
        assertThat(queue.get("tokens")).isEmpty();
    }

    @Test
    void aTrackingLinkFromAnotherDayStillOpens() {
        String id = issue(staff, "Yesterday", "9876500000").data().get("id").asText();
        moveTo(() -> clock.advance(Duration.ofDays(1)));
        Api.Response tracked = api.get(CLINIC + "/tokens/" + id);
        assertThat(tracked.status()).isEqualTo(200);
        assertThat(tracked.data().at("/token/token_number").asInt()).isEqualTo(1);
    }

    @Test
    void theDatabaseRefusesADuplicateNumberEvenIfTheCodeTriedOne() {
        issueOne("First");
        // The unique index is the actual guarantee, not the numbering code.
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> tokens.insert(
                        com.queuelite.support.TestDatabase.CLINIC_ID, 1, "Duplicate", "9876500000",
                        queue.today(), queue.now()))
                .isInstanceOf(org.springframework.dao.DuplicateKeyException.class);
    }

    @Test
    void invalidPatientDetailsAreRefused() {
        assertThat(issue(staff, "A", "9876500000").status()).isEqualTo(400);
        assertThat(issue(staff, "Valid Name", "98765").status()).isEqualTo(400);
        assertThat(issue(staff, "Valid Name", "98765abcde").status()).isEqualTo(400);
        assertThat(staff.post(CLINIC + "/tokens", "{\"patient_name\":42,\"patient_phone\":9876500000}").status())
                .isEqualTo(400);
        assertThat(staff.post(CLINIC + "/tokens", "not json").status()).isEqualTo(400);
        assertThat(api.post(CLINIC + "/tokens", "{\"patient_name\":\"No Session\",\"patient_phone\":\"9876500000\"}")
                .status()).isEqualTo(401);
    }
}
