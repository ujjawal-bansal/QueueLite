const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const KEY_LENGTH = 64;

// Compares in constant time so a correct value cannot be found by timing.
const verifyAgainstHash = (value, storedHash, envName) => {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  const parts = String(storedHash || '').split('$');

  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    throw new Error(
      `${envName} is malformed - regenerate it with \`npm run ${
        envName === 'STAFF_PASSCODE_HASH' ? 'hash-passcode' : 'generate-recovery'
      }\``
    );
  }

  const [, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, 'hex');

  let actual;

  try {
    actual = crypto.scryptSync(value, salt, KEY_LENGTH);
  } catch {
    return false;
  }

  if (actual.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
};

const verifyPasscode = (passcode) =>
  verifyAgainstHash(passcode, env.staffPasscodeHash, 'STAFF_PASSCODE_HASH');

const isRecoveryEnabled = () => Boolean(env.staffRecoveryCodeHash);

/**
 * The break-glass code. Returns false rather than throwing when no code is
 * configured, so a deployment that never set one simply has no second door.
 */
const verifyRecoveryCode = (code) => {
  if (!isRecoveryEnabled()) {
    return false;
  }

  return verifyAgainstHash(code, env.staffRecoveryCodeHash, 'STAFF_RECOVERY_CODE_HASH');
};

// `via` records how this session was obtained, so the dashboard can tell staff
// they are signed in on the break-glass code and the passcode still needs
// resetting - otherwise a clinic quietly runs on the recovery code for months.
const issueSession = (via = 'passcode') =>
  jwt.sign({ role: 'staff', clinic: env.clinicSlug, via }, env.sessionSecret, {
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

module.exports = {
  verifyPasscode,
  verifyRecoveryCode,
  isRecoveryEnabled,
  issueSession,
  readSession,
  cookieOptions,
};
