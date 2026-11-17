package com.queuelite.queue;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

class QueueRulesTest {

    static final Instant NOW = Instant.parse("2026-08-28T05:00:00Z"); // 10:30 IST
    static final Clinic CLINIC = new Clinic(UUID.randomUUID(), "Dev Eye Care", "dev-eye-care", null, null,
            null, null, "10:00:00", "18:00:00", 15);

    static Token token(int number, String status) {
        return token(number, status, null, null);
    }

    static Token token(int number, String status, String position, Instant calledInAt) {
        return new Token(UUID.nameUUIDFromBytes(("t" + number).getBytes()), CLINIC.id(), number, "Patient " + number,
                "98000000" + String.format("%02d", number), status,
                OffsetDateTime.ofInstant(NOW, ZoneOffset.UTC), LocalDate.of(2026, 8, 28),
                calledInAt == null ? null : OffsetDateTime.ofInstant(calledInAt, ZoneOffset.UTC), null,
                position == null ? null : new BigDecimal(position), null, null, null, null, null);
    }

    static Token withPosition(Token token, BigDecimal position, String status) {
        return new Token(token.id(), token.clinicId(), token.tokenNumber(), token.patientName(), token.patientPhone(),
                status, token.createdAt(), token.tokenDay(), null, null, position, null, null, null, null, null);
    }

    static List<Token> waiting(int count) {
        List<Token> list = new ArrayList<>();
        for (int number = 1; number <= count; number++) {
            list.add(token(number, Token.WAITING));
        }
        return list;
    }

    static List<Integer> order(List<Token> tokens) {
        return QueueRules.waitingInOrder(tokens).stream().map(Token::tokenNumber).toList();
    }

    static List<Token> replace(List<Token> tokens, Token updated) {
        return tokens.stream().map(token -> token.id().equals(updated.id()) ? updated : token).toList();
    }

    @Nested
    class Order {
        @Test
        void aQueueNobodyHasDeferredIsOrderedByTokenNumber() {
            assertThat(order(List.of(token(3, "waiting"), token(1, "waiting"), token(2, "waiting"))))
                    .containsExactly(1, 2, 3);
        }

        @Test
        void pushingAPatientBackByThreePutsThreePatientsInFrontOfThem() {
            List<Token> tokens = waiting(6);
            Token first = tokens.getFirst();
            BigDecimal position = QueueRules.positionAfter(tokens, first, 3);
            assertThat(order(replace(tokens, withPosition(first, position, Token.WAITING))))
                    .containsExactly(2, 3, 4, 1, 5, 6);
        }

        @Test
        void eachPushBackMovesThePatientFurtherNeverForwards() {
            List<Token> tokens = waiting(8);
            Token first = tokens.getFirst();
            for (int round = 0; round < 3; round++) {
                Token current = tokens.stream().filter(t -> t.tokenNumber() == 1).findFirst().orElseThrow();
                int before = QueueRules.countPatientsAhead(tokens, current);
                tokens = replace(tokens, withPosition(first, QueueRules.positionAfter(tokens, current, 2), Token.WAITING));
                Token moved = tokens.stream().filter(t -> t.tokenNumber() == 1).findFirst().orElseThrow();
                assertThat(QueueRules.countPatientsAhead(tokens, moved)).isEqualTo(Math.min(before + 2, 7));
            }
        }

        @Test
        void pushingBackFurtherThanTheQueueIsLongPutsThemLast() {
            List<Token> tokens = waiting(4);
            Token first = tokens.getFirst();
            assertThat(order(replace(tokens, withPosition(first, QueueRules.positionAfter(tokens, first, 50), "waiting"))))
                    .containsExactly(2, 3, 4, 1);
        }

        @Test
        void theOnlyPatientWaitingCannotBePushedBehindAnybody() {
            Token only = token(1, Token.WAITING);
            assertThat(QueueRules.positionAfter(List.of(only), only, 3)).isEqualByComparingTo("1");
        }

        @Test
        void aNoShowReturningLateGoesWhereStaffPutThemNotToTheFront() {
            List<Token> tokens = new ArrayList<>(waiting(6));
            Token late = token(1, Token.NO_SHOW);
            tokens.set(0, late);
            BigDecimal position = QueueRules.positionAfter(tokens, late, 2);
            assertThat(order(replace(tokens, withPosition(late, position, Token.WAITING))))
                    .containsExactly(2, 3, 1, 4, 5, 6);
        }

        @Test
        void deferredPatientsKeepAStableOrder() {
            List<Token> tokens = List.of(token(5, "waiting", "2.5", null), token(4, "waiting", "2.5", null),
                    token(2, "waiting"), token(3, "waiting"));
            assertThat(order(tokens)).containsExactly(2, 4, 5, 3);
        }

        @Test
        void patientsAheadCountsQueueOrderNotLowerTokenNumbers() {
            Token deferred = token(1, "waiting", "4.5", null);
            List<Token> tokens = List.of(deferred, token(2, "waiting"), token(3, "waiting"),
                    token(4, "waiting"), token(5, "waiting"), token(6, "done"));
            assertThat(QueueRules.countPatientsAhead(tokens, deferred)).isEqualTo(3);
            assertThat(QueueRules.countPatientsAhead(tokens, tokens.get(1))).isZero();
        }

        @Test
        void nowServingIsTheInProgressTokenAndWaitingExcludesIt() {
            QueueRules.Context context = QueueRules.context(List.of(token(1, "done"), token(2, "in_progress"),
                    token(3, "waiting"), token(4, "waiting")));
            assertThat(context.currentTokenNumber()).isEqualTo(2);
            assertThat(context.waitingCount()).isEqualTo(2);
            assertThat(QueueRules.context(List.of()).currentTokenNumber()).isNull();
        }
    }

    @Nested
    class Pace {
        List<Token> calledInEvery(double... minutes) {
            List<Token> tokens = new ArrayList<>();
            Instant at = NOW;
            tokens.add(token(1, "done", null, at));
            for (int index = 0; index < minutes.length; index++) {
                at = at.plusMillis(Math.round(minutes[index] * 60000));
                tokens.add(token(index + 2, "done", null, at));
            }
            return tokens;
        }

        @Test
        void theClinicFigureDecidesWhileMeasuringIsOff() {
            QueueRules.Pace pace = QueueRules.minutesPerPatient(calledInEvery(4, 4, 4, 4), CLINIC, null, false, 15);
            assertThat(pace).isEqualTo(new QueueRules.Pace(15, false, "clinic", 0));
        }

        @Test
        void aClinicWithNoFigureOfItsOwnFallsBackToTheConfiguredDefault() {
            Clinic none = new Clinic(CLINIC.id(), "x", "x", null, null, null, null, null, null, null);
            assertThat(QueueRules.minutesPerPatient(List.of(), none, null, false, 9).minutesPerPatient()).isEqualTo(9);
        }

        @Test
        void theMeasuredPaceComesFromTheGapsBetweenCallIns() {
            QueueRules.Pace pace = QueueRules.minutesPerPatient(calledInEvery(5, 7, 6), CLINIC, null, true, 15);
            assertThat(pace.minutesPerPatient()).isEqualTo(6);
            assertThat(pace.source()).isEqualTo("today");
        }

        @Test
        void aLunchBreakIsNotAveragedInAsAVerySlowPatient() {
            assertThat(QueueRules.callInGapsOf(calledInEvery(5, 90, 6))).containsExactly(5.0, 6.0);
        }

        @Test
        void oneLongConsultDoesNotDragEveryEstimateUp() {
            assertThat(QueueRules.minutesPerPatient(calledInEvery(5, 5, 35, 5), CLINIC, null, true, 15)
                    .minutesPerPatient()).isEqualTo(5);
        }

        @Test
        void recentDaysAnswerForTheMorningBeforeTodayCan() {
            QueueRules.Pace pace = QueueRules.minutesPerPatient(calledInEvery(5), CLINIC,
                    new QueueRules.History(7.5, 40, 6), true, 15);
            assertThat(pace).isEqualTo(new QueueRules.Pace(7.5, true, "history", 40));
        }

        @Test
        void withMeasuringOnButNothingToMeasureTheClinicFigureStands() {
            assertThat(QueueRules.minutesPerPatient(List.of(), CLINIC, null, true, 15).source()).isEqualTo("default");
        }
    }

    @Nested
    class Estimates {
        @Test
        void aWaitingPatientIsQuotedTheirPlaceTimesThePace() {
            assertThat(QueueRules.estimateReadyAt(4, 15, NOW)).isEqualTo(NOW.plus(Duration.ofMinutes(60)));
            assertThat(QueueRules.estimateReadyAt(0, 15, NOW)).isEqualTo(NOW);
        }

        @Test
        void anEstimateThatLandsAfterClosingIsRecognised() {
            // Closing is 18:00 IST = 12:30 UTC; the grace runs to 13:00 UTC.
            assertThat(QueueRules.isAfterClosing(Instant.parse("2026-08-28T13:01:00Z"), CLINIC, NOW)).isTrue();
            assertThat(QueueRules.isAfterClosing(Instant.parse("2026-08-28T12:50:00Z"), CLINIC, NOW)).isFalse();
            assertThat(QueueRules.isAfterClosing(Instant.parse("2026-08-28T09:00:00Z"), CLINIC, NOW)).isFalse();
            assertThat(QueueRules.isAfterClosing(null, CLINIC, NOW)).isFalse();
        }

        @Test
        void aClinicWithNoClosingTimeNeverFlagsAnEstimate() {
            Clinic open = new Clinic(CLINIC.id(), "x", "x", null, null, null, null, null, null, 15);
            assertThat(QueueRules.isAfterClosing(NOW.plus(Duration.ofDays(1)), open, NOW)).isFalse();
        }
    }
}
