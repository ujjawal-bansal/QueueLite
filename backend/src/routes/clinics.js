const express = require('express');
const {
  healthCheck,
  getClinic,
  getBoard,
  createToken,
  getTodayQueue,
  callInToken,
  callNext,
  pushBackToken,
  completeToken,
  markNoShow,
  restoreToken,
  getToken,
} = require('../controllers/clinicsController');
const {
  addFollowUp,
  getFollowUps,
  completeFollowUp,
  cancelFollowUp,
} = require('../controllers/followUpsController');
const { requireStaff } = require('../middleware/requireStaff');
const { writeLimiter, publicLimiter } = require('../middleware/rateLimits');

const router = express.Router();

// Public
router.get('/health', healthCheck);
router.get('/clinic', publicLimiter, getClinic);
router.get('/clinics/:slug/board', publicLimiter, getBoard);
router.get('/clinics/:slug/tokens/:tokenId', publicLimiter, getToken);

// Staff only - these expose or mutate patient data
router.get('/clinics/:slug/queue/today', requireStaff, getTodayQueue);
router.post('/clinics/:slug/tokens', requireStaff, writeLimiter, createToken);
router.post('/clinics/:slug/call-next', requireStaff, writeLimiter, callNext);
router.patch('/clinics/:slug/tokens/:tokenId/call-in', requireStaff, writeLimiter, callInToken);
router.patch('/clinics/:slug/tokens/:tokenId/push-back', requireStaff, writeLimiter, pushBackToken);
router.patch('/clinics/:slug/tokens/:tokenId/done', requireStaff, writeLimiter, completeToken);
router.patch('/clinics/:slug/tokens/:tokenId/no-show', requireStaff, writeLimiter, markNoShow);
router.patch('/clinics/:slug/tokens/:tokenId/restore', requireStaff, writeLimiter, restoreToken);

// Follow-ups. Staff only: patient names, numbers and the doctor's notes, with
// no unguessable link standing in for authentication. Nothing here messages a
// patient; the desk contacts them from the list.
router.get('/clinics/:slug/follow-ups', requireStaff, getFollowUps);
router.post('/clinics/:slug/tokens/:tokenId/follow-up', requireStaff, writeLimiter, addFollowUp);
router.patch('/clinics/:slug/follow-ups/:followUpId/done', requireStaff, writeLimiter, completeFollowUp);
router.patch('/clinics/:slug/follow-ups/:followUpId/cancel', requireStaff, writeLimiter, cancelFollowUp);

module.exports = router;
