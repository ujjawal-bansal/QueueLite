const rateLimit = require('express-rate-limit');

const message = (error) => ({ success: false, error });

// Brute-forcing a shared passcode is the main risk on this endpoint.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many sign-in attempts. Try again in a few minutes.'),
});

// Generous enough for a busy front desk, tight enough to stop a script.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many requests. Slow down for a moment.'),
});

// Patient tracking pages poll this every few seconds.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many requests. Slow down for a moment.'),
});

module.exports = { loginLimiter, writeLimiter, publicLimiter };
