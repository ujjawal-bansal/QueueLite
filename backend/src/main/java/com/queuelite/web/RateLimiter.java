package com.queuelite.web;

import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Fixed-window request budgets, the same ones the Node API had.
 *
 * The frontend proxies /api through Vercel, so most requests arrive from
 * Vercel's edge rather than each visitor's address: these budgets are shared
 * by everyone at once. Sized for one clinic, and still low enough to stop a
 * passcode from being brute-forced.
 */
@Component
public class RateLimiter {

    public enum Budget {
        LOGIN(30, Duration.ofMinutes(15), "Too many sign-in attempts. Try again in a few minutes."),
        // Used once in a blue moon, so the budget can be tiny - and tiny is what
        // makes a long random code impractical to guess.
        RECOVERY(10, Duration.ofHours(1), "Too many recovery attempts. Try again later."),
        // Generous enough for a busy front desk, tight enough to stop a script.
        WRITE(240, Duration.ofMinutes(1), "Too many requests. Slow down for a moment."),
        // ~100 open trackers polling on their own schedules. A morning where
        // everyone arrives at once must not hit this.
        PUBLIC(3000, Duration.ofMinutes(1), "Too many requests. Slow down for a moment.");

        final int limit;
        final Duration window;
        final String message;

        Budget(int limit, Duration window, String message) {
            this.limit = limit;
            this.window = window;
            this.message = message;
        }

        public int limit() { return limit; }
        public Duration window() { return window; }
        public String message() { return message; }
    }

    public record Decision(boolean allowed, int limit, int remaining, long resetSeconds) {}

    private record Window(long startedAt, int count) {}

    private final Clock clock;
    private final Map<String, Window> windows = new ConcurrentHashMap<>();

    public RateLimiter(Clock clock) {
        this.clock = clock;
    }

    public Decision hit(Budget budget, String client) {
        long now = clock.millis();
        long windowMs = budget.window.toMillis();

        Window updated = windows.compute(budget.name() + "|" + client, (key, current) ->
                current == null || now - current.startedAt >= windowMs
                        ? new Window(now, 1)
                        : new Window(current.startedAt, current.count + 1));

        // Expired windows would otherwise accumulate one entry per address.
        if (windows.size() > 10_000) {
            windows.entrySet().removeIf(entry -> now - entry.getValue().startedAt >= Duration.ofHours(1).toMillis());
        }

        long reset = Math.max(0, (updated.startedAt + windowMs - now + 999) / 1000);
        return new Decision(updated.count <= budget.limit, budget.limit,
                Math.max(0, budget.limit - updated.count), reset);
    }

    public void reset() {
        windows.clear();
    }
}
