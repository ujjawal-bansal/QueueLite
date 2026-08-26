const env = require('../config/env');
const logger = require('../utils/logger');
const {
  verifyPasscode,
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

const logout = (req, res) => {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ success: true, data: { signed_out: true } });
};

const session = (req, res) => {
  res.json({
    success: true,
    data: { signed_in: true, clinic_slug: req.staff.clinic },
  });
};

module.exports = { login, logout, session };
