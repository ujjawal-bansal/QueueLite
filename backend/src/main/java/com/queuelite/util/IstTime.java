package com.queuelite.util;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The queue day is an Asia/Kolkata calendar day, not a UTC one: token numbers
 * restart at IST midnight regardless of where the server runs.
 */
public final class IstTime {

    public static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    private static final Pattern CLOCK = Pattern.compile("^(\\d{1,2}):(\\d{2})");
    private static final DateTimeFormatter CLOCK_FORMAT =
            DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH).withZone(IST);

    private IstTime() {}

    public record Range(Instant start, Instant end) {}

    /** The UTC instants bounding "today" at the clinic. */
    public static Range todayUtcRange(Instant now) {
        Instant start = today(now).atStartOfDay(IST).toInstant();
        return new Range(start, start.plus(Duration.ofDays(1)));
    }

    /** Today's date at the clinic. */
    public static LocalDate today(Instant now) {
        return LocalDate.ofInstant(now, IST);
    }

    /** The clinic date {@code days} from today. */
    public static LocalDate addDays(long days, Instant now) {
        return today(now).plusDays(days);
    }

    /**
     * The instant of a wall-clock time ("18:00:00") on the current clinic day.
     * How the app knows whether an estimate has run past closing time.
     */
    public static Instant instantToday(String localTime, Instant now) {
        if (localTime == null) {
            return null;
        }
        Matcher match = CLOCK.matcher(localTime);
        if (!match.find()) {
            return null;
        }
        int hours = Integer.parseInt(match.group(1));
        int minutes = Integer.parseInt(match.group(2));
        return todayUtcRange(now).start().plus(hours * 60L + minutes, ChronoUnit.MINUTES);
    }

    /**
     * A wall-clock time at the clinic, e.g. "3:40 pm". The server runs in UTC,
     * so anything shown to a patient has to be rendered in Kolkata time.
     */
    public static String formatClock(Instant instant) {
        return CLOCK_FORMAT.format(instant).toLowerCase(Locale.ROOT);
    }

    /** How far off a date is, in clinic days. */
    public static long daysUntil(LocalDate dueOn, Instant now) {
        return ChronoUnit.DAYS.between(today(now), dueOn);
    }
}
