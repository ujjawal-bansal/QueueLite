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

// Generous enough for a busy front desk, tight enough to stop a script.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many requests. Slow down for a moment.'),
});

// Patient tracking pages poll this every few seconds, and every patient sitting
// in the clinic shares one public IP over its wifi - so this budget is consumed
// by the whole waiting room at once, not by one person.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many requests. Slow down for a moment.'),
});

module.exports = { loginLimiter, writeLimiter, publicLimiter };
