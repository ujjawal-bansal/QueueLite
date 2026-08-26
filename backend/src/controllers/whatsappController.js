const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const notifier = require('../services/notifier');
const {
  getClinicBySlug,
  getTodayTokens,
  findActiveTokenByPhone,
  getQueueContext,
  countPatientsAhead,
} = require('../services/queueService');

const MINUTES_PER_PATIENT = 5;

/**
 * Meta's one-time subscription handshake: echo back hub.challenge when the
 * verify token matches the one configured in the app dashboard.
 */
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.whatsapp.verifyToken) {
    logger.info('whatsapp webhook verified');
    return res.status(200).send(challenge);
  }

  logger.warn('whatsapp webhook verification rejected');
  return res.sendStatus(403);
};

/**
 * Every delivery is signed with the app secret. Without this check anyone who
 * learns the URL could feed us fake patient messages.
 */
const hasValidSignature = (req) => {
  const header = req.get('x-hub-signature-256');

  if (!header || !req.rawBody) {
    return false;
  }

  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', env.whatsapp.appSecret)
      .update(req.rawBody)
      .digest('hex');

  const a = Buffer.from(header);
  const b = Buffer.from(expected);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const buildStatusReply = async (clinic, phone) => {
  const token = await findActiveTokenByPhone(clinic.id, phone);

  if (!token) {
    return (
      `We could not find an active token for this number at ${clinic.name} today. ` +
      'Please check with the front desk.'
    );
  }

  const tokens = await getTodayTokens(clinic.id);
  const context = getQueueContext(tokens);
  const link = notifier.trackingUrl(clinic.slug, token.id);

  if (token.status === 'in_progress') {
    return `It's your turn now - token #${token.token_number}. Please go in.`;
  }

  const ahead = countPatientsAhead(tokens, token);
  const nowServing = context.current_token_number
    ? `Now serving #${context.current_token_number}.`
    : 'The queue has not started yet.';

  if (ahead === 0) {
    return `You're next - token #${token.token_number}. ${nowServing} Track: ${link}`;
  }

  return (
    `Your token is #${token.token_number}. ${nowServing} ` +
    `${ahead} ${ahead === 1 ? 'patient' : 'patients'} ahead of you, roughly ` +
    `${ahead * MINUTES_PER_PATIENT} minutes. Track: ${link}`
  );
};

/**
 * Replies always land inside the 24h service window the patient just opened by
 * messaging us, so they can be free-form text rather than a template.
 */
const receiveWebhook = async (req, res) => {
  if (!hasValidSignature(req)) {
    logger.warn('whatsapp webhook signature mismatch');
    return res.sendStatus(403);
  }

  // Acknowledge immediately - Meta retries anything slower than a few seconds.
  res.sendStatus(200);

  try {
    const messages = req.body?.entry?.flatMap(
      (entry) => entry?.changes?.flatMap((change) => change?.value?.messages || []) || []
    );

    if (!messages || messages.length === 0) {
      return undefined;
    }

    const clinic = await getClinicBySlug(env.clinicSlug);

    if (!clinic) {
      logger.error({ slug: env.clinicSlug }, 'whatsapp bot: clinic not found');
      return undefined;
    }

    for (const message of messages) {
      if (message.type !== 'text') {
        await notifier.replyToPatient(
          message.from,
          'Send any message to check your place in the queue.'
        );
        continue;
      }

      logger.info({ type: message.type }, 'whatsapp message received');

      const reply = await buildStatusReply(clinic, message.from);
      await notifier.replyToPatient(message.from, reply);
    }
  } catch (error) {
    logger.error({ err: { message: error.message } }, 'whatsapp webhook handling failed');
  }

  return undefined;
};

module.exports = {
  verifyWebhook,
  receiveWebhook,
  buildStatusReply,
  hasValidSignature,
};
