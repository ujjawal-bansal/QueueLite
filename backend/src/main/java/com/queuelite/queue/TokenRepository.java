package com.queuelite.queue;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Every SQL statement the API runs against {@code clinics} and {@code tokens}.
 *
 * Plain SQL over JDBC: the queries are few, and seeing them as written is
 * worth more here than an ORM's convenience.
 */
@Repository
public class TokenRepository {

    static final RowMapper<Token> TOKEN = (rs, row) -> new Token(
            rs.getObject("id", UUID.class),
            rs.getObject("clinic_id", UUID.class),
            rs.getInt("token_number"),
            rs.getString("patient_name"),
            rs.getString("patient_phone"),
            rs.getString("status"),
            timestamp(rs, "created_at"),
            rs.getObject("token_day", LocalDate.class),
            timestamp(rs, "called_in_at"),
            timestamp(rs, "completed_at"),
            rs.getBigDecimal("queue_position"),
            rs.getObject("follow_up_due_on", LocalDate.class),
            rs.getString("follow_up_note"),
            rs.getString("follow_up_status"),
            timestamp(rs, "heads_up_sent_at"),
            timestamp(rs, "turn_notified_at"));

    private static final RowMapper<Clinic> CLINIC = (rs, row) -> new Clinic(
            rs.getObject("id", UUID.class),
            rs.getString("name"),
            rs.getString("slug"),
            rs.getString("doctor_name"),
            rs.getString("address"),
            rs.getString("phone"),
            rs.getString("maps_url"),
            rs.getString("opens_at"),
            rs.getString("closes_at"),
            (Integer) rs.getObject("avg_consult_minutes"));

    private final JdbcClient jdbc;
    /** How many times today's queue was read from the database; the tests watch it. */
    private final AtomicInteger todayReads = new AtomicInteger();

    public TokenRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Clinic> findClinicBySlug(String slug) {
        return jdbc.sql("select * from clinics where slug = :slug")
                .param("slug", slug)
                .query(CLINIC)
                .optional();
    }

    /**
     * Today's tokens, by the day stored on the row: the day a token counts
     * towards is written once when it is issued, so nothing re-derives it.
     */
    public List<Token> findForDay(UUID clinicId, LocalDate day) {
        todayReads.incrementAndGet();
        return jdbc.sql("select * from tokens where clinic_id = :clinic and token_day = :day order by token_number")
                .param("clinic", clinicId)
                .param("day", day)
                .query(TOKEN)
                .list();
    }

    public int todayReads() {
        return todayReads.get();
    }

    public Optional<Token> findById(UUID clinicId, UUID tokenId) {
        return jdbc.sql("select * from tokens where id = :id and clinic_id = :clinic")
                .param("id", tokenId)
                .param("clinic", clinicId)
                .query(TOKEN)
                .optional();
    }

    /**
     * Inserts a token with the given number. The unique index on
     * (clinic_id, token_day, token_number) refuses a number already issued,
     * which surfaces as a DuplicateKeyException for the caller to retry.
     */
    public Token insert(UUID clinicId, int tokenNumber, String name, String phone, LocalDate day, Instant now) {
        return jdbc.sql("""
                        insert into tokens (clinic_id, token_number, patient_name, patient_phone, status, token_day, created_at)
                        values (:clinic, :number, :name, :phone, 'waiting', :day, :now)
                        returning *""")
                .param("clinic", clinicId)
                .param("number", tokenNumber)
                .param("name", name)
                .param("phone", phone)
                .param("day", day)
                .param("now", utc(now))
                .query(TOKEN)
                .single();
    }

    /**
     * Closes out whoever is being seen and calls in the given token, in one
     * transaction, so a failure between the two cannot leave the clinic with
     * nobody marked as being seen.
     */
    @Transactional
    public Optional<Token> callIn(UUID clinicId, UUID tokenId, LocalDate day, Instant now) {
        jdbc.sql("""
                        update tokens set status = 'done'
                         where clinic_id = :clinic and status = 'in_progress' and id <> :id and token_day = :day""")
                .param("clinic", clinicId)
                .param("id", tokenId)
                .param("day", day)
                .update();

        return jdbc.sql("""
                        update tokens set status = 'in_progress', called_in_at = :now
                         where id = :id and clinic_id = :clinic
                        returning *""")
                .param("now", utc(now))
                .param("id", tokenId)
                .param("clinic", clinicId)
                .query(TOKEN)
                .optional();
    }

    /**
     * Back in the queue at a new position. They were not actually seen, so the
     * call-in must not count towards the measured pace, and whatever they were
     * told about their old position no longer holds.
     */
    public Optional<Token> pushBack(UUID clinicId, UUID tokenId, BigDecimal position) {
        return jdbc.sql("""
                        update tokens
                           set queue_position = :position, status = 'waiting',
                               called_in_at = null, completed_at = null,
                               heads_up_sent_at = null, turn_notified_at = null
                         where id = :id and clinic_id = :clinic
                        returning *""")
                .param("position", position)
                .param("id", tokenId)
                .param("clinic", clinicId)
                .query(TOKEN)
                .optional();
    }

    public Optional<Token> setStatus(UUID clinicId, UUID tokenId, String status, Instant now) {
        String extra = switch (status) {
            // The only honest record of when a visit ended.
            case Token.DONE -> ", completed_at = :now";
            // Back in the queue means back to being un-notified.
            case Token.WAITING -> ", heads_up_sent_at = null, turn_notified_at = null, called_in_at = null, completed_at = null";
            default -> "";
        };

        var statement = jdbc.sql("update tokens set status = :status" + extra
                        + " where id = :id and clinic_id = :clinic returning *")
                .param("status", status)
                .param("id", tokenId)
                .param("clinic", clinicId);

        if (status.equals(Token.DONE)) {
            statement = statement.param("now", utc(now));
        }

        return statement.query(TOKEN).optional();
    }

    /**
     * Claims a reminder, returning true only for the caller that won.
     *
     * A conditional update: whoever flips the null wins, everyone else gets zero
     * rows and sends nothing. That holds across a retried request and across
     * the two instances a redeploy briefly runs.
     */
    public boolean claimReminder(UUID tokenId, String kind, Instant now) {
        String column = reminderColumn(kind);
        return jdbc.sql("update tokens set " + column + " = :now where id = :id and " + column + " is null")
                .param("now", utc(now))
                .param("id", tokenId)
                .update() > 0;
    }

    /** Hands a claim back, used only when the send definitely did not happen. */
    public void releaseReminder(UUID tokenId, String kind) {
        jdbc.sql("update tokens set " + reminderColumn(kind) + " = null where id = :id")
                .param("id", tokenId)
                .update();
    }

    public record CallIn(Instant calledInAt, Instant createdAt) {}

    /** Call-in times from before today, for seeding the measured pace. */
    public List<CallIn> callInsBetween(UUID clinicId, Instant from, Instant to) {
        return jdbc.sql("""
                        select called_in_at, created_at from tokens
                         where clinic_id = :clinic and called_in_at is not null
                           and created_at >= :from and created_at < :to
                         order by called_in_at""")
                .param("clinic", clinicId)
                .param("from", utc(from))
                .param("to", utc(to))
                .query((rs, row) -> new CallIn(
                        timestamp(rs, "called_in_at").toInstant(),
                        timestamp(rs, "created_at").toInstant()))
                .list();
    }

    // ---- follow-ups: stored on the visit they were given at ----

    public Optional<Token> setFollowUp(UUID tokenId, LocalDate dueOn, String note) {
        return jdbc.sql("""
                        update tokens
                           set follow_up_due_on = :due, follow_up_note = :note, follow_up_status = 'scheduled'
                         where id = :id
                        returning *""")
                .param("due", dueOn)
                .param("note", note)
                .param("id", tokenId)
                .query(TOKEN)
                .optional();
    }

    /** Open follow-ups due on or before {@code until}, overdue ones included. */
    public List<Token> openFollowUps(UUID clinicId, LocalDate until) {
        return jdbc.sql("""
                        select * from tokens
                         where clinic_id = :clinic and follow_up_status = 'scheduled' and follow_up_due_on <= :until
                         order by follow_up_due_on""")
                .param("clinic", clinicId)
                .param("until", until)
                .query(TOKEN)
                .list();
    }

    /** Only a token that actually carries a follow-up can have one closed. */
    public Optional<Token> setFollowUpStatus(UUID clinicId, UUID tokenId, String status) {
        return jdbc.sql("""
                        update tokens set follow_up_status = :status
                         where id = :id and clinic_id = :clinic and follow_up_due_on is not null
                        returning *""")
                .param("status", status)
                .param("id", tokenId)
                .param("clinic", clinicId)
                .query(TOKEN)
                .optional();
    }

    private static String reminderColumn(String kind) {
        return switch (kind) {
            case "heads_up" -> "heads_up_sent_at";
            case "your_turn" -> "turn_notified_at";
            default -> throw new IllegalArgumentException("unknown reminder kind: " + kind);
        };
    }

    private static OffsetDateTime timestamp(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.withOffsetSameInstant(ZoneOffset.UTC);
    }

    private static OffsetDateTime utc(Instant instant) {
        return instant.atOffset(ZoneOffset.UTC);
    }
}
