require('dotenv').config();

const problems = [];

const required = (key, { when = true, hint = '' } = {}) => {
  const value = process.env[key];

  if (when && (!value || !value.trim())) {
    problems.push(`  ${key} is required${hint ? ` - ${hint}` : ''}`);
    return '';
  }

  return (value || '').trim();
};

const optional = (key, fallback = '') => (process.env[key] || fallback).trim();

const nodeEnv = optional('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

const notifier = optional('NOTIFIER', 'console').toLowerCase();
const useWhatsApp = notifier === 'whatsapp';

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');

const env = {
  nodeEnv,
  isProduction,
  port: Number(optional('PORT', '3001')),

  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  frontendUrl: stripTrailingSlash(required('FRONTEND_URL', {
    hint: 'the public URL of the patient/staff site, used for CORS and tracking links',
  })),

  // Vercel serves the same app on preview hostnames too, and a request from
  // one of those is rejected by CORS in a way the browser reports only as a
  // failed connection. List any extra origins here rather than debugging it.
  extraAllowedOrigins: optional('ALLOWED_ORIGINS', '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  clinicSlug: required('CLINIC_SLUG', {
    hint: 'the single clinic this deployment serves, e.g. sharma-clinic',
  }),

  sessionSecret: required('SESSION_SECRET', {
    hint: 'random 32+ char string; run `npm run generate-secrets`',
  }),
  staffPasscodeHash: required('STAFF_PASSCODE_HASH', {
    hint: 'run `npm run hash-passcode` and paste the result',
  }),
  sessionTtlHours: Number(optional('SESSION_TTL_HOURS', '12')),

  notifier,
  whatsapp: {
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID', { when: useWhatsApp }),
    accessToken: required('WHATSAPP_ACCESS_TOKEN', { when: useWhatsApp }),
    verifyToken: required('WHATSAPP_VERIFY_TOKEN', { when: useWhatsApp }),
    appSecret: required('WHATSAPP_APP_SECRET', {
      when: useWhatsApp,
      hint: 'used to verify webhook signatures',
    }),
    graphVersion: optional('WHATSAPP_GRAPH_VERSION', 'v21.0'),
    templateTokenIssued: optional('WHATSAPP_TEMPLATE_TOKEN_ISSUED', 'queue_token_issued'),
    templateYourTurn: optional('WHATSAPP_TEMPLATE_YOUR_TURN', 'queue_your_turn'),
    templateLocale: optional('WHATSAPP_TEMPLATE_LOCALE', 'en'),
    countryCode: optional('WHATSAPP_COUNTRY_CODE', '91'),
  },
};

if (env.sessionSecret && env.sessionSecret.length < 32) {
  problems.push('  SESSION_SECRET must be at least 32 characters');
}

if (!Number.isFinite(env.port) || env.port <= 0) {
  problems.push('  PORT must be a positive number');
}

if (isProduction && env.frontendUrl.startsWith('http://')) {
  problems.push('  FRONTEND_URL must use https in production');
}

if (problems.length > 0) {
  console.error(
    `\nQueueLite cannot start - check your .env file:\n\n${problems.join('\n')}\n\n` +
      'See .env.example for the full list.\n'
  );
  process.exit(1);
}

module.exports = env;
