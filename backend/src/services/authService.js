const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const KEY_LENGTH = 64;

// Compares in constant time so a wrong passcode cannot be found by timing.
const verifyPasscode = (passcode) => {
  if (typeof passcode !== 'string' || passcode.length === 0) {
    return false;
  }

  const parts = env.staffPasscodeHash.split('$');

  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    throw new Error(
      'STAFF_PASSCODE_HASH is malformed - regenerate it with `npm run hash-passcode`'
    );
  }

  const [, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, 'hex');

  let actual;

  try {
    actual = crypto.scryptSync(passcode, salt, KEY_LENGTH);
  } catch {
    return false;
  }

  if (actual.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
};

const issueSession = () =>
  jwt.sign({ role: 'staff', clinic: env.clinicSlug }, env.sessionSecret, {
    expiresIn: `${env.sessionTtlHours}h`,
  });

const readSession = (token) => {
  if (!token) {
    return null;
  }

  try {
    return jwt.verify(token, env.sessionSecret);
  } catch {
    return null;
  }
};

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: env.isProduction ? 'none' : 'lax',
  maxAge: env.sessionTtlHours * 60 * 60 * 1000,
  path: '/',
});

module.exports = { verifyPasscode, issueSession, readSession, cookieOptions };
