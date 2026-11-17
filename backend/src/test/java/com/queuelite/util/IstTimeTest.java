package com.queuelite.util;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

class IstTimeTest {

    @Test
    void anIstDayStartsAt1830UtcThePreviousDay() {
        IstTime.Range range = IstTime.todayUtcRange(Instant.parse("2026-08-28T05:00:00Z"));
        assertThat(range.start()).isEqualTo(Instant.parse("2026-08-27T18:30:00Z"));
    }

    @Test
    void anInstantJustBeforeIstMidnightBelongsToThePreviousDay() {
        assertThat(IstTime.today(Instant.parse("2026-08-28T18:29:59Z"))).isEqualTo(LocalDate.of(2026, 8, 28));
    }

    @Test
    void anInstantJustAfterIstMidnightRollsToTheNextDay() {
        assertThat(IstTime.today(Instant.parse("2026-08-28T18:30:00Z"))).isEqualTo(LocalDate.of(2026, 8, 29));
    }

    @Test
    void theWindowIsExactlyTwentyFourHours() {
        IstTime.Range range = IstTime.todayUtcRange(Instant.parse("2026-08-28T05:00:00Z"));
        assertThat(Duration.between(range.start(), range.end())).isEqualTo(Duration.ofDays(1));
    }

    @Test
    void aClinicTimeBecomesAnInstantOnTodaysClinicDay() {
        assertThat(IstTime.instantToday("18:00:00", Instant.parse("2026-08-28T05:00:00Z")))
                .isEqualTo(Instant.parse("2026-08-28T12:30:00Z"));
        assertThat(IstTime.instantToday(null, Instant.now())).isNull();
        assertThat(IstTime.instantToday("closed", Instant.now())).isNull();
    }

    @Test
    void clockTimesAreRenderedTheWayPatientsReadThem() {
        assertThat(IstTime.formatClock(Instant.parse("2026-08-28T10:10:00Z"))).isEqualTo("3:40 pm");
        assertThat(IstTime.formatClock(Instant.parse("2026-08-28T04:35:00Z"))).isEqualTo("10:05 am");
    }

    @Test
    void followUpDatesAreCountedInClinicDays() {
        // 18:20 UTC is 23:50 in Moradabad: still the 28th at the clinic.
        Instant lateEvening = Instant.parse("2026-08-28T18:20:00Z");
        assertThat(IstTime.addDays(15, lateEvening)).isEqualTo(LocalDate.of(2026, 9, 12));
        assertThat(IstTime.daysUntil(LocalDate.of(2026, 9, 12), lateEvening)).isEqualTo(15);
    }
}
