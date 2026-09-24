const express = require('express');
const {
  login,
  recover,
  googleLogin,
  methods,
  logout,
  session,
} = require('../controllers/authController');
const { requireStaff } = require('../middleware/requireStaff');
const { loginLimiter, recoveryLimiter } = require('../middleware/rateLimits');

const router = express.Router();

router.post('/login', loginLimiter, login);
router.post('/recover', recoveryLimiter, recover);
router.post('/google', loginLimiter, googleLogin);
router.get('/methods', methods);
router.post('/logout', logout);
router.get('/session', requireStaff, session);

module.exports = router;
