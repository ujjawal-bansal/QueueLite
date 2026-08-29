const rateLimit = require('express-rate-limit');

const message = (error) => ({ success: false, error });

// The frontend proxies /api through Vercel, so requests reach us from Vercel's
// edge rather than each visitor's address: these budgets are now shared by
// everyone at once. Sized for one clinic, and still low enough to stop a
// passcode from being brute-forced.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many sign-in attempts. Try again in a few minutes.'),
});

// The break-glass code is used once in a blue moon, so the budget can be tiny -
// and tiny is what makes a long random code impractical to guess. Every request
// reaches us from Vercel's edge, so this is a single global budget: an attacker
// hammering it also locks out real staff, who can fall back to resetting the
// passcode on the server.
const recoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many recovery attempts. Try again later.'),
});

// Generous enough for a busy front desk, tight enough to stop a script.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many requests. Slow down for a moment.'),
});

// Patient tracking pages poll this, and every request arrives from Vercel's
// edge, so one budget covers every patient at once rather than one person.
//
// Sized from the worst case the clinic actually has: ~100 open trackers, each
// polling on its own schedule. Someone at the front of the queue refreshes
// every 10s, someone forty back every couple of minutes, which averages out
// well under this - but a morning where everyone arrives at once must not hit
// a limit, because the failure mode is a waiting room full of stuck pages.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many requests. Slow down for a moment.'),
});

module.exports = { loginLimiter, recoveryLimiter, writeLimiter, publicLimiter };
