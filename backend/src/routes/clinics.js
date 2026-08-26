const express = require('express');
const {
  healthCheck,
  getClinic,
  createToken,
  getTodayQueue,
  callInToken,
  completeToken,
  markNoShow,
  restoreToken,
  getToken,
} = require('../controllers/clinicsController');
const { requireStaff } = require('../middleware/requireStaff');
const { writeLimiter, publicLimiter } = require('../middleware/rateLimits');

const router = express.Router();

// Public
router.get('/health', healthCheck);
router.get('/clinic', publicLimiter, getClinic);
router.get('/clinics/:slug/tokens/:tokenId', publicLimiter, getToken);

// Staff only - these expose or mutate patient data
router.get('/clinics/:slug/queue/today', requireStaff, getTodayQueue);
router.post('/clinics/:slug/tokens', requireStaff, writeLimiter, createToken);
router.patch('/clinics/:slug/tokens/:tokenId/call-in', requireStaff, writeLimiter, callInToken);
router.patch('/clinics/:slug/tokens/:tokenId/done', requireStaff, writeLimiter, completeToken);
router.patch('/clinics/:slug/tokens/:tokenId/no-show', requireStaff, writeLimiter, markNoShow);
router.patch('/clinics/:slug/tokens/:tokenId/restore', requireStaff, writeLimiter, restoreToken);

module.exports = router;
