/**
 * Sends one WhatsApp message using the configured credentials, and explains
 * whatever Meta says back. Run this before wiring up the webhook - it isolates
 * "are my credentials right?" from "is my app right?".
 *
 *   npm run test-whatsapp -- 9876543210
 *   npm run test-whatsapp -- 9876543210 hello_world
 */

require('dotenv').config();

const phoneArg = process.argv[2];
const templateArg = process.argv[3] || 'hello_world';

const {
  WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
  WHATSAPP_ACCESS_TOKEN: TOKEN,
  WHATSAPP_GRAPH_VERSION: VERSION = 'v21.0',
  WHATSAPP_TEMPLATE_LOCALE: LOCALE = 'en',
  WHATSAPP_COUNTRY_CODE: COUNTRY = '91',
} = process.env;

const fail = (message) => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

if (!phoneArg) {
  fail('Usage: npm run test-whatsapp -- <10-digit-phone> [template-name]');
}

const missing = [
  !PHONE_ID && 'WHATSAPP_PHONE_NUMBER_ID',
  !TOKEN && 'WHATSAPP_ACCESS_TOKEN',
].filter(Boolean);

if (missing.length) {
  fail(`Not set in .env: ${missing.join(', ')}`);
}

const digits = String(phoneArg).replace(/\D/g, '');
const to = digits.length === 10 ? `${COUNTRY}${digits}` : digits.replace(/^0+/, '');

// hello_world is pre-approved by Meta and takes no variables, so it proves the
// credentials work even before your own templates are approved.
const isHelloWorld = templateArg === 'hello_world';

const payload = {
  messaging_product: 'whatsapp',
  to,
  type: 'template',
  template: {
    name: templateArg,
    language: { code: isHelloWorld ? 'en_US' : LOCALE },
    ...(isHelloWorld
      ? {}
      : {
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'Test Clinic' },
                { type: 'text', text: '7' },
                { type: 'text', text: 'https://example.com/q/test/123' },
              ],
            },
          ],
        }),
  },
};

const HINTS = {
  190: 'Access token is invalid or expired. Dashboard tokens last 24h - generate a permanent System User token.',
  100: 'Usually a bad phone number id, or a template name/locale that does not exist.',
  131030: 'Recipient is not in your allow-list. In test mode add the number under WhatsApp > API Setup.',
  132001: 'Template not found. Check the exact name and language, and that it is APPROVED.',
  132000: 'Template variable count does not match what the template declares.',
  133010: 'Phone number is not registered on WhatsApp.',
  10: 'Permission denied - the token is missing whatsapp_business_messaging.',
};

(async () => {
  console.log(`\n  -> sending "${templateArg}" to +${to}\n`);

  const response = await fetch(
    `https://graph.facebook.com/${VERSION}/${PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );

  const body = await response.json().catch(() => ({}));

  if (response.ok) {
    console.log('  SENT. Message id:', body?.messages?.[0]?.id);
    console.log('  Check the phone. If nothing arrives, the number is likely');
    console.log('  not in the test allow-list.\n');
    return;
  }

  const error = body?.error || {};
  const code = error.code;

  console.error(`  FAILED (HTTP ${response.status})`);
  console.error(`  ${error.message || 'no message'}`);

  if (error.error_data?.details) {
    console.error(`  details: ${error.error_data.details}`);
  }

  if (HINTS[code]) {
    console.error(`\n  Likely cause: ${HINTS[code]}`);
  }

  console.error('');
  process.exit(1);
})().catch((error) => fail(`Request failed: ${error.message}`));
