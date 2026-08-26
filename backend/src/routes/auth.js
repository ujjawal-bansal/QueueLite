const express = require('express');
const { login, logout, session } = require('../controllers/authController');
const { requireStaff } = require('../middleware/requireStaff');
const { loginLimiter } = require('../middleware/rateLimits');

const router = express.Router();

router.post('/login', loginLimiter, login);
router.post('/logout', logout);
router.get('/session', requireStaff, session);

module.exports = router;
