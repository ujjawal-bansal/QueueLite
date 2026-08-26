const env = require('../../config/env');
const logger = require('../../utils/logger');

const { whatsapp: config } = env;

// Meta expects E.164 without the leading "+". A bare 10-digit Indian number
// gets the country code prefixed; anything already longer is passed through.
const toE164 = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');

  if (digits.length === 10) {
    return `${config.countryCode}${digits}`;
  }

  return digits.replace(/^0+/, '');
};

const graphUrl = () =>
  `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;

const post = async (payload) => {
  const response = await fetch(graphUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = body?.error?.message || `HTTP ${response.status}`;
    const error = new Error(`WhatsApp send failed: ${detail}`);
    error.statusCode = response.status;
    error.meta = body?.error;
    throw error;
  }

  return body;
};

/**
 * Business-initiated messages must use a template approved in Meta's dashboard.
 * `variables` fill the template's {{1}}, {{2}}, ... placeholders in order.
 */
const sendTemplate = async (phone, templateName, variables = []) => {
  const to = toE164(phone);

  const components = variables.length
    ? [
        {
          type: 'body',
          parameters: variables.map((text) => ({ type: 'text', text: String(text) })),
        },
      ]
    : [];

  const result = await post({
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: config.templateLocale },
      components,
    },
  });

  logger.info(
    { template: templateName, messageId: result?.messages?.[0]?.id },
    'whatsapp template sent'
  );

  return result;
};

/**
 * Free-form text. Only delivers inside the 24-hour service window opened by the
 * patient messaging us first - Meta rejects it otherwise.
 */
const sendText = async (phone, body) => {
  const to = toE164(phone);

  const result = await post({
    to,
    type: 'text',
    text: { preview_url: true, body },
  });

  logger.info({ messageId: result?.messages?.[0]?.id }, 'whatsapp reply sent');

  return result;
};

module.exports = { sendTemplate, sendText, toE164 };
