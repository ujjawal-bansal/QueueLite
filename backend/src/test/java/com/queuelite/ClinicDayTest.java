package com.queuelite;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.queuelite.support.Api;
import com.queuelite.support.ApiTestBase;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.stream.IntStream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.TestMethodOrder;

/**
 * A simulated hundred-patient clinic day, driven through the real HTTP API
 * against a real Postgres: issued, called, pushed back, no-showed, restored
 * and tracked. The steps build on each other, in order, like the day does.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ClinicDayTest extends ApiTestBase {

    private Api staff;

    @BeforeAll
    void openTheClinic() {
        resetDay();
        staff = signedIn();
        assertThat(staff.get("/api/auth/session").status()).isEqualTo(200);
    }

    private List<JsonNode> todayTokens() {
        JsonNode list = staff.get(CLINIC + "/queue/today").data().get("tokens");
        return StreamSupport.stream(list.spliterator(), false).toList();
    }

    private List<JsonNode> waitingByNumber() {
        return todayTokens().stream()
                .filter(token -> token.get("status").asText().equals("waiting"))
                .sorted(Comparator.comparingInt(token -> token.get("token_number").asInt()))
                .toList();
    }

    private List<Integer> sentTo(String kind) {
        return notifier.of(kind).stream().map(message -> message.tokenNumber()).toList();
    }

    @Test
    @Order(1)
    void aHundredPatientsAreIssuedTokensOneToAHundredInOrder() {
        for (int index = 1; index <= 100; index++) {
            Api.Response created = issue(staff, "Patient " + index, String.valueOf(9000000000L + index));

            assertThat(created.status()).as("token %d was not created", index).isEqualTo(201);
            assertThat(created.data().get("token_number").asInt()).isEqualTo(index);
        }

        assertThat(todayTokens()).hasSize(100);
    }

    @Test
    @Order(2)
    void theDeskIsToldWhenANewPatientWillBeSeenNotJustTheirNumber() {
        JsonNode queue = staff.get(CLINIC + "/queue/today").data();
        assertThat(queue.get("waiting_count").asInt()).isEqualTo(100);
        assertThat(queue.get("total_today").asInt()).isEqualTo(100);

        JsonNode created = issue(staff, "Late Arrival", "9811111111").data();
        assertThat(created.get("patients_ahead").asInt()).isEqualTo(100);
        assertThat(created.get("estimated_ready_at").isNull()).isFalse();
        assertThat(created.get("tracking_url").asText()).contains(created.get("id").asText());
        // Six minutes a patient from 10:30 puts patient #101 well past closing.
        assertThat(created.get("estimate_after_closing").asBoolean()).isTrue();
    }

    @Test
    @Order(3)
    void onlyTheFrontOfTheQueueIsMessagedHoweverLongTheQueueIs() {
        assertThat(sentTo("issued")).hasSize(101);
        assertThat(sentTo("your_turn")).containsExactly(1);
        assertThat(sentTo("heads_up")).containsExactly(2, 3, 4);
    }

    @Test
    @Order(4)
    void callingPatientsInWalksTheReminderWindowDownTheQueue() {
        for (int index = 1; index <= 10; index++) {
            Api.Response called = staff.post(CLINIC + "/call-next", null);
            assertThat(called.status()).isEqualTo(200);
            assertThat(called.data().get("token_number").asInt()).isEqualTo(index);
        }

        assertThat(sentTo("your_turn")).containsExactly(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
        assertThat(sentTo("heads_up")).containsExactly(2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14);

        // At most one patient is ever being seen.
        assertThat(todayTokens().stream().filter(token -> token.get("status").asText().equals("in_progress")))
                .hasSize(1);
    }

    @Test
    @Order(5)
    void noPatientIsEverMessagedTwiceAboutTheSameTurn() {
        Set<String> seen = new HashSet<>();
        notifier.sent.stream()
                .filter(message -> !message.kind().equals("issued"))
                .forEach(message -> assertThat(seen.add(message.kind() + ":" + message.tokenNumber()))
                        .as("%s:%d was sent more than once", message.kind(), message.tokenNumber())
                        .isTrue());
    }

    @Test
    @Order(6)
    void anUndoneMisTapDoesNotReAnnounceATurnThePatientAlreadyHad() {
        int before = sentTo("your_turn").size();
        JsonNode current = todayTokens().stream()
                .filter(token -> token.get("status").asText().equals("in_progress"))
                .findFirst()
                .orElseThrow();

        staff.patch(CLINIC + "/tokens/" + current.get("id").asText() + "/done", null);
        staff.patch(CLINIC + "/tokens/" + current.get("id").asText() + "/restore", null);

        // Restoring puts them back at the front, so they are told once that they
        // are next again - and nobody behind them is re-announced.
        List<Integer> after = sentTo("your_turn");
        assertThat(after).hasSize(before + 1);
        assertThat(after.getLast()).isEqualTo(current.get("token_number").asInt());
    }

    @Test
    @Order(7)
    void aNoShowPullsTheQueueForwardAndEveryoneNewlyInRangeIsWarned() {
        int before = notifier.sent.size();
        JsonNode front = waitingByNumber().getFirst();

        staff.patch(CLINIC + "/tokens/" + front.get("id").asText() + "/no-show", null);

        List<JsonNode> waiting = waitingByNumber();
        assertThat(waiting).noneMatch(token -> token.get("id").equals(front.get("id")));

        // The invariant the reminder engine exists to hold: nobody inside the
        // lead window is left un-messaged, whatever moved them there.
        assertThat(waiting.getFirst().get("turn_notified_at").isNull()).isFalse();
        waiting.subList(1, 4).forEach(token ->
                assertThat(token.get("heads_up_sent_at").isNull())
                        .as("#%s is inside the window but was not warned", token.get("token_number"))
                        .isFalse());

        // And a queue moving by one place does not become a burst of messages.
        assertThat(notifier.sent.size() - before).isLessThanOrEqualTo(1);
    }

    @Test
    @Order(8)
    void aPatientTrackingTheirLinkSeesAPositionAndAnExpectedTime() {
        List<JsonNode> waiting = waitingByNumber();
        JsonNode target = waiting.getLast();

        // The tracking link is public: no cookie on this request.
        Api.Response tracked = api.get(CLINIC + "/tokens/" + target.get("id").asText());

        assertThat(tracked.status()).isEqualTo(200);
        JsonNode data = tracked.data();
        assertThat(data.at("/token/token_number").asInt()).isEqualTo(target.get("token_number").asInt());
        assertThat(data.get("patients_ahead").asInt()).isEqualTo(waiting.size() - 1);
        assertThat(data.get("estimated_ready_at").isNull()).isFalse();
        assertThat(data.at("/clinic/name").asText()).isEqualTo("Dev Eye Care");
        assertThat(data.at("/clinic/phone").asText()).isEqualTo("+919368444330");
        assertThat(data.at("/clinic/closes_at").asText()).isEqualTo("18:00:00");

        // The public endpoint must never hand out a phone number.
        assertThat(data.get("token").has("patient_phone")).isFalse();
        assertThat(tracked.text()).doesNotContain(String.valueOf(9000000000L + target.get("token_number").asInt()));
    }

    @Test
    @Order(9)
    void theWholeWaitingRoomPollingAtOnceDoesNotMultiplyDatabaseReads() {
        String id = waitingByNumber().getFirst().get("id").asText();
        queue.invalidate(com.queuelite.support.TestDatabase.CLINIC_ID);
        int before = tokens.todayReads();

        List<CompletableFuture<Api.Response>> polls = IntStream.range(0, 100)
                .mapToObj(index -> CompletableFuture.supplyAsync(() -> new Api(port).get(CLINIC + "/tokens/" + id)))
                .toList();
        polls.forEach(poll -> assertThat(poll.join().status()).isEqualTo(200));

        // 100 patients refreshing at once; the day's tokens are fetched once.
        assertThat(tokens.todayReads() - before).isEqualTo(1);
    }

    @Test
    @Order(10)
    void aWhatsAppOutageDoesNotCostAPatientTheirNotification() {
        int before = sentTo("your_turn").size();
        notifier.deliveryFails = true;

        staff.post(CLINIC + "/call-next", null);
        assertThat(sentTo("your_turn")).as("a send got through").hasSize(before);

        JsonNode stranded = waitingByNumber().getFirst();
        assertThat(stranded.get("turn_notified_at").isNull())
                .as("the failed send stayed claimed, so it could never be retried")
                .isTrue();

        // The channel comes back, and the next thing that moves the queue retries.
        notifier.deliveryFails = false;
        staff.post(CLINIC + "/call-next", null);
        staff.patch(CLINIC + "/tokens/" + stranded.get("id").asText() + "/restore", null);

        assertThat(sentTo("your_turn").size()).isGreaterThan(before);
    }

    @Test
    @Order(11)
    void calledInAgainstAnotherClinicOrAMalformedIdIsNotFound() {
        assertThat(staff.patch(CLINIC + "/tokens/not-a-uuid/call-in", null).status()).isEqualTo(404);
        assertThat(staff.patch(CLINIC + "/tokens/00000000-0000-0000-0000-000000000000/call-in", null).status())
                .isEqualTo(404);
        assertThat(staff.get("/api/clinics/someone-else/queue/today").body().get("error").asText())
                .isEqualTo("Clinic not found");
    }

    @Test
    @Order(12)
    void callingNextWithAnEmptyQueueIsRefusedRatherThanGuessedAt() {
        com.queuelite.support.TestDatabase.execute("update tokens set status = 'done' where status = 'waiting'");
        queue.invalidate(com.queuelite.support.TestDatabase.CLINIC_ID);

        Api.Response called = staff.post(CLINIC + "/call-next", null);
        assertThat(called.status()).isEqualTo(409);
        assertThat(called.body().get("error").asText()).isEqualTo("Nobody is waiting");
    }

    @Test
    @Order(13)
    void thePublicBoardReportsTheQueueWithoutIdentifyingAnybody() {
        Api.Response board = api.get(CLINIC + "/board");

        assertThat(board.status()).isEqualTo(200);
        assertThat(board.data().at("/clinic/name").asText()).isEqualTo("Dev Eye Care");
        assertThat(board.data().get("waiting_count").isNumber()).isTrue();
        assertThat(board.data().get("recently_called").isArray()).isTrue();
        assertThat(board.data().get("recently_called")).hasSizeLessThanOrEqualTo(5);

        assertThat(board.text()).doesNotContain("patient_name", "patient_phone", "Patient 1");
    }

    @Test
    @Order(14)
    void aPatientGivenOnlyANumberOverThePhoneCanLookItUp() {
        JsonNode target = issue(staff, "Phone Booking", "9812345678").data();

        JsonNode lookup = api.get(CLINIC + "/board?token=" + target.get("token_number").asInt()).data().get("lookup");

        assertThat(lookup.get("found").asBoolean()).isTrue();
        assertThat(lookup.get("token_number").asInt()).isEqualTo(target.get("token_number").asInt());
        assertThat(lookup.get("status").asText()).isEqualTo("waiting");
        assertThat(lookup.get("patients_ahead").isNumber()).isTrue();
        assertThat(lookup.get("estimated_ready_at").isNull()).isFalse();
        assertThat(lookup.has("patient_name")).isFalse();
        assertThat(lookup.has("patient_phone")).isFalse();
    }

    @Test
    @Order(15)
    void lookingUpANumberThatWasNeverIssuedSaysSoPlainly() {
        JsonNode lookup = api.get(CLINIC + "/board?token=9999").data().get("lookup");
        assertThat(lookup.toString()).isEqualTo("{\"token_number\":9999,\"found\":false}");
    }

    @Test
    @Order(16)
    void aNonsenseTokenInTheBoardQueryIsIgnoredNotAnswered() {
        Api.Response board = api.get(CLINIC + "/board?token=abc");
        assertThat(board.status()).isEqualTo(200);
        assertThat(board.data().has("lookup")).isFalse();
    }

    @Test
    @Order(20)
    void aPatientWhoDoesNotAnswerKeepsTheirPlaceInTheDay() {
        resetDay();
        for (int index = 1; index <= 6; index++) {
            issue(staff, "Late " + index, String.valueOf(9700000000L + index));
        }
        assertThat(orderOfQueue()).containsExactly(1, 2, 3, 4, 5, 6);

        // #1 is called and does not turn up.
        staff.post(CLINIC + "/call-next", null);
        String first = idOf(1);

        Api.Response pushed = staff.patch(CLINIC + "/tokens/" + first + "/push-back", "{\"places\":3}");
        assertThat(pushed.status()).isEqualTo(200);
        assertThat(pushed.data().get("status").asText()).isEqualTo("waiting");
        assertThat(pushed.data().get("called_in_at").isNull())
                .as("a missed call still counted as a consultation").isTrue();

        // Three patients now get seen before them, and they are still in the queue.
        assertThat(orderOfQueue()).containsExactly(2, 3, 4, 1, 5, 6);
    }

    @Test
    @Order(21)
    void beingPushedBackEarnsAFreshReminderAtTheNewPosition() {
        JsonNode first = tokenNumbered(1);

        // The old "you're next" no longer describes where they stand.
        assertThat(first.get("turn_notified_at").isNull()).as("the stale turn notice was kept").isTrue();
        // At three ahead they are inside the lead window again.
        assertThat(sentTo("heads_up")).contains(1);
        assertThat(first.get("heads_up_sent_at").isNull()).isFalse();
    }

    @Test
    @Order(22)
    void pushBackRefusesANonsenseNumberOfPlaces() {
        String target = waitingByNumber().getFirst().get("id").asText();
        for (String places : List.of("0", "-3", "1.5", "999", "\"three\"", "null")) {
            assertThat(staff.patch(CLINIC + "/tokens/" + target + "/push-back", "{\"places\":" + places + "}").status())
                    .as("places=%s was accepted", places)
                    .isEqualTo(400);
        }
    }

    @Test
    @Order(23)
    void pushBackNeedsASignedInStaffMember() {
        String target = waitingByNumber().getFirst().get("id").asText();
        assertThat(api.patch(CLINIC + "/tokens/" + target + "/push-back", "{\"places\":3}").status()).isEqualTo(401);
    }

    @Test
    @Order(30)
    void theDoctorsInstructionToComeBackIsRecordedAgainstTheVisit() {
        JsonNode token = issue(staff, "Review Patient", "9812300011").data();
        String id = token.get("id").asText();
        staff.patch(CLINIC + "/tokens/" + id + "/call-in", null);
        staff.patch(CLINIC + "/tokens/" + id + "/done", null);

        Api.Response followUp = staff.post(CLINIC + "/tokens/" + id + "/follow-up",
                "{\"days\":15,\"note\":\"bring old glasses\"}");

        assertThat(followUp.status()).isEqualTo(201);
        JsonNode data = followUp.data();
        assertThat(data.get("patient_name").asText()).isEqualTo("Review Patient");
        assertThat(data.get("status").asText()).isEqualTo("scheduled");
        assertThat(data.get("note").asText()).isEqualTo("bring old glasses");
        assertThat(data.get("patient_phone").asText()).isEqualTo("9812300011");
        assertThat(data.get("id").asText()).isEqualTo(id);
        assertThat(data.get("due_on").asText()).isEqualTo("2026-09-12");

        JsonNode listed = followUps().stream().filter(f -> f.get("id").asText().equals(id)).findFirst().orElseThrow();
        assertThat(listed.get("days_until").asInt()).isEqualTo(15);
    }

    @Test
    @Order(31)
    void aFollowUpIntervalThatMakesNoSenseIsRefused() {
        String done = todayTokens().stream()
                .filter(token -> token.get("status").asText().equals("done"))
                .findFirst().orElseThrow().get("id").asText();

        for (String days : List.of("0", "-5", "2.5", "400", "\"soon\"", "null")) {
            assertThat(staff.post(CLINIC + "/tokens/" + done + "/follow-up", "{\"days\":" + days + "}").status())
                    .as("days=%s was accepted", days)
                    .isEqualTo(400);
        }
    }

    @Test
    @Order(32)
    void markingAPatientAsReturnedTakesThemOffTheList() {
        JsonNode target = followUps().getFirst();
        String id = target.get("id").asText();

        Api.Response done = staff.patch(CLINIC + "/follow-ups/" + id + "/done", null);
        assertThat(done.status()).isEqualTo(200);
        assertThat(done.data().get("status").asText()).isEqualTo("completed");
        assertThat(followUps()).noneMatch(f -> f.get("id").asText().equals(id));

        // Closing a follow-up must not touch the visit it hangs off.
        assertThat(tokenWithId(id).get("status").asText()).isEqualTo("done");
    }

    @Test
    @Order(33)
    void followUpsAreStaffOnly() {
        assertThat(api.get(CLINIC + "/follow-ups").status()).isEqualTo(401);
    }

    @Test
    @Order(34)
    void theDeskIsToldWhereItsWaitEstimateCameFrom() {
        JsonNode data = staff.get(CLINIC + "/queue/today").data();
        assertThat(data.get("pace_source").asText()).isIn("clinic", "today", "history", "default");
        assertThat(data.get("minutes_per_patient").isNumber()).isTrue();
        assertThat(data.get("pace_measured").isBoolean()).isTrue();
        assertThat(data.get("reminder_lead_patients").asInt()).isEqualTo(3);
        assertThat(data.get("auto_reminders").asBoolean()).isTrue();
    }

    @Test
    @Order(40)
    void twoEntriesLandingTogetherTakeDifferentNumbers() {
        List<CompletableFuture<Api.Response>> entries = new ArrayList<>();
        for (int index = 0; index < 4; index++) {
            int patient = index;
            Api desk = signedIn();
            entries.add(CompletableFuture.supplyAsync(() -> issue(desk, "Together " + patient, "980000000" + patient)));
        }
        entries.forEach(entry -> assertThat(entry.join().status()).as("a collision reached the desk").isEqualTo(201));

        List<Integer> numbers = todayTokens().stream().map(token -> token.get("token_number").asInt()).toList();
        assertThat(numbers).doesNotHaveDuplicates();
    }

    // ---- helpers ----

    private List<Integer> orderOfQueue() {
        return todayTokens().stream()
                .filter(token -> token.get("status").asText().equals("waiting"))
                .sorted(Comparator
                        .comparingDouble((JsonNode token) -> token.get("queue_position").isNull()
                                ? token.get("token_number").asDouble()
                                : token.get("queue_position").asDouble())
                        .thenComparingInt(token -> token.get("token_number").asInt()))
                .map(token -> token.get("token_number").asInt())
                .toList();
    }

    private JsonNode tokenNumbered(int number) {
        return todayTokens().stream().filter(token -> token.get("token_number").asInt() == number).findFirst().orElseThrow();
    }

    private JsonNode tokenWithId(String id) {
        return todayTokens().stream().filter(token -> token.get("id").asText().equals(id)).findFirst().orElseThrow();
    }

    private String idOf(int number) {
        return tokenNumbered(number).get("id").asText();
    }

    private List<JsonNode> followUps() {
        JsonNode list = staff.get(CLINIC + "/follow-ups").data().get("follow_ups");
        return StreamSupport.stream(list.spliterator(), false).toList();
    }
}
