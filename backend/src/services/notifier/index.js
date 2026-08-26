const env = require('../../config/env');
const logger = require('../../utils/logger');
const whatsapp = require('./whatsapp');

const useWhatsApp = env.notifier === 'whatsapp';

/**
 * Notifications must never take the queue down with them: a WhatsApp outage
 * should not stop the front desk from issuing a token. Every send is therefore
 * best-effort, and failures are logged rather than thrown.
 */
const safely = async (label, fn) => {
  try {
    await fn();
    return true;
  } catch (error) {
    logger.error(
      { err: { message: error.message, meta: error.meta } },
      `${label} failed`
    );
    return false;
  }
};

const trackingUrl = (slug, tokenId) => `${env.frontendUrl}/q/${slug}/${tokenId}`;

const notifyTokenIssued = async ({ phone, clinicName, tokenNumber, slug, tokenId }) => {
  const link = trackingUrl(slug, tokenId);

  if (!useWhatsApp) {
    logger.info(
      { to: '[redacted]', tokenNumber, link },
      `[notifier stub] token issued -> #${tokenNumber} at ${clinicName}: ${link}`
    );
    return true;
  }

  // Meta's template review rejects two things this message once had: a raw URL
  // as a body variable, and the word "token" (read as an auth code). So the
  // template carries only the number - the tracking link reaches the patient
  // via the desk QR code, or via the bot's free-form reply when they message us.
  return safely('token-issued notification', () =>
    whatsapp.sendTemplate(phone, env.whatsapp.templateTokenIssued, [
      String(tokenNumber),
    ])
  );
};

const notifyYourTurn = async ({ phone, clinicName, tokenNumber, currentTokenNumber }) => {
  if (!useWhatsApp) {
    logger.info(
      { to: '[redacted]', tokenNumber },
      `[notifier stub] you're next -> #${tokenNumber}, now serving #${currentTokenNumber}`
    );
    return true;
  }

  // Business name cannot be a variable in an approved template, so it is baked
  // into the template text rather than passed in.
  return safely('your-turn notification', () =>
    whatsapp.sendTemplate(phone, env.whatsapp.templateYourTurn, [
      String(currentTokenNumber),
      String(tokenNumber),
    ])
  );
};

// Replies to an inbound patient message, inside the 24h service window.
const replyToPatient = async (phone, body) => {
  if (!useWhatsApp) {
    logger.info({ to: '[redacted]' }, `[notifier stub] reply -> ${body}`);
    return true;
  }

  return safely('whatsapp reply', () => whatsapp.sendText(phone, body));
};

module.exports = {
  notifyTokenIssued,
  notifyYourTurn,
  replyToPatient,
  trackingUrl,
  isWhatsAppEnabled: useWhatsApp,
};
