package com.queuelite.support;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

/** A clock the tests can move, so "tomorrow" and "an hour later" are instant. */
public class MutableClock extends Clock {

    // 10:30 in Moradabad on an ordinary weekday.
    public static final Instant MORNING = Instant.parse("2026-08-28T05:00:00Z");

    private volatile Instant now = MORNING;

    public void set(Instant instant) {
        now = instant;
    }

    public void advance(Duration duration) {
        now = now.plus(duration);
    }

    @Override
    public Instant instant() {
        return now;
    }

    @Override
    public ZoneId getZone() {
        return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
        return this;
    }
}
