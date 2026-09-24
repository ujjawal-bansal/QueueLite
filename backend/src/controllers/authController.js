const env = require('../config/env');
const logger = require('../utils/logger');
const {
  verifyPasscode,
  verifyRecoveryCode,
  isRecoveryEnabled,
  isGoogleEnabled,
  verifyGoogleCredential,
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

// Worded for the person at the login screen, who can do something about the
// second and third but not the first.
const GOOGLE_REFUSALS = {
  invalid: { status: 401, error: 'Google sign-in did not go through. Try again.' },
  unverified: { status: 403, error: 'That Google account has no verified email.' },
  not_listed: {
    status: 403,
    error: 'That Google account is not on the staff list. Ask the clinic to add it.',
  },
};

/**
 * Sign in with Google.
 *
 * The browser hands over the ID token Google gave it; everything that matters
 * is checked here, not there. Only accounts listed in STAFF_GOOGLE_EMAILS get a
 * session, and it is the same staff session the passcode issues.
 */
const googleLogin = async (req, res, next) => {
  try {
    if (!isGoogleEnabled()) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const result = await verifyGoogleCredential(req.body?.credential);

    if (!result.ok) {
      // Who tried is worth keeping: a refused staff member is a list to fix,
      // and a run of strangers is worth knowing about.
      logger.warn(
        { ip: req.ip, reason: result.reason, email: result.email, detail: result.detail },
        'refused Google sign-in'
      );

      const refusal = GOOGLE_REFUSALS[result.reason] || GOOGLE_REFUSALS.invalid;
      return res.status(refusal.status).json({ success: false, error: refusal.error });
    }

    res.cookie(
      SESSION_COOKIE,
      issueSession('google', { email: result.email }),
      cookieOptions()
    );
    logger.info({ ip: req.ip, email: result.email }, 'staff signed in with Google');

    res.json({
      success: true,
      data: { clinic_slug: env.clinicSlug, via: 'google', email: result.email },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Which ways in this deployment offers, for the login screen to draw. The
 * client ID is public by design - Google shows it to every browser that signs
 * in - but the staff list is never sent anywhere.
 */
const methods = (req, res) => {
  res.json({
    success: true,
    data: { google_client_id: isGoogleEnabled() ? env.googleClientId : null },
  });
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
      email: req.staff.email || null,
      recovery_available: isRecoveryEnabled(),
    },
  });
};

module.exports = { login, recover, googleLogin, methods, logout, session };
