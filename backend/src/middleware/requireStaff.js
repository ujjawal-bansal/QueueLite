const { readSession } = require('../services/authService');

const SESSION_COOKIE = 'ql_session';

const requireStaff = (req, res, next) => {
  const session = readSession(req.cookies?.[SESSION_COOKIE]);

  if (!session || session.role !== 'staff') {
    return res.status(401).json({ success: false, error: 'Not signed in' });
  }

  req.staff = session;
  next();
};

module.exports = { requireStaff, SESSION_COOKIE };
