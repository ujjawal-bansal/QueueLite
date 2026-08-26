const express = require('express');
const { verifyWebhook, receiveWebhook } = require('../controllers/whatsappController');

const router = express.Router();

router.get('/webhook', verifyWebhook);
router.post('/webhook', receiveWebhook);

module.exports = router;
