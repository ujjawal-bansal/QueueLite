const express = require('express');
const {
  healthCheck,
  createClinic,
  createToken,
  getTodayQueue,
  callInToken,
  markNoShow,
  getToken,
} = require('../controllers/clinicsController');

const router = express.Router();

router.get('/health', healthCheck);
router.post('/clinics', createClinic);
router.post('/clinics/:slug/tokens', createToken);
router.get('/clinics/:slug/queue/today', getTodayQueue);
router.patch('/clinics/:slug/tokens/:tokenId/call-in', callInToken);
router.patch('/clinics/:slug/tokens/:tokenId/no-show', markNoShow);
router.get('/clinics/:slug/tokens/:tokenId', getToken);

module.exports = router;
