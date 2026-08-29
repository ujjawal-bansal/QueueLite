const env = require('../config/env');
const logger = require('../utils/logger');
const {
  verifyPasscode,
  verifyRecoveryCode,
  isRecoveryEnabled,
  issueSession,
  cookieOptions,
} = require('../services/authService');
const { SESSION_COOKIE } = require('../middleware/requireStaff');

const login = (req, res, next) => {
  try {
    const { passcode } = req.body || {};

    if (!verifyPasscode(passcode)) {
      logger.warn({ ip: req.ip }, 'failed staff login');
      return res.status(401).json({ success: false, error: 'Incorrect passcode' });
    }

    res.cookie(SESSION_COOKIE, issueSession(), cookieOptions());
    logger.info({ ip: req.ip }, 'staff signed in');

    res.json({ success: true, data: { clinic_slug: env.clinicSlug } });
  } catch (error) {
    next(error);
  }
};

/**
 * Break-glass sign-in with the recovery code.
 *
 * A second door into patient data, so it is deliberately narrow: hard rate
 * limited, constant-time compared, absent entirely when no code is configured,
 * and loudly logged either way. The session it issues is marked so the
 * dashboard can keep telling staff the passcode still needs resetting.
 */
const recover = (req, res, next) => {
  try {
    if (!isRecoveryEnabled()) {
      // 404 rather than 403: an endpoint that is switched off should not
      // confirm that it exists and might work with the right input.
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const { code } = req.body || {};

    if (!verifyRecoveryCode(code)) {
      logger.warn({ ip: req.ip }, 'failed recovery sign-in');
      return res.status(401).json({ success: false, error: 'Incorrect recovery code' });
    }

    res.cookie(SESSION_COOKIE, issueSession('recovery'), cookieOptions());
    // Worth finding in the logs months later: this should be rare, and a run of
    // them means either the passcode is forgotten constantly or someone is
    // guessing.
    logger.warn({ ip: req.ip }, 'staff signed in with the RECOVERY CODE');

    res.json({ success: true, data: { clinic_slug: env.clinicSlug, via: 'recovery' } });
  } catch (error) {
    next(error);
  }
};

const logout = (req, res) => {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ success: true, data: { signed_out: true } });
};

const session = (req, res) => {
  res.json({
    success: true,
    data: {
      signed_in: true,
      clinic_slug: req.staff.clinic,
      // Lets the dashboard show that this session came from the break-glass
      // code, so a clinic does not quietly run on it for months.
      via: req.staff.via || 'passcode',
      recovery_available: isRecoveryEnabled(),
    },
  });
};

module.exports = { login, recover, logout, session };
