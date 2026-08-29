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

  // Break-glass sign-in for the morning the desk cannot remember the passcode.
  // Optional: unset means the recovery route is off entirely rather than
  // present-but-unusable, so there is no second door unless one is asked for.
  staffRecoveryCodeHash: optional('STAFF_RECOVERY_CODE_HASH', ''),

  notifier,

  // How many patients ahead trigger the "you're close, start heading over"
  // reminder. On a 100-patient day this is the message that matters: the turn
  // notification alone arrives when the patient needs to already be in the
  // room, which is useless to someone who went home to wait.
  reminderLeadPatients: Number(optional('REMINDER_LEAD_PATIENTS', '3')),

  // How long the clinic budgets per patient. Every wait estimate is built from
  // this. The clinic row's avg_consult_minutes overrides it.
  avgConsultMinutes: Number(optional('AVG_CONSULT_MINUTES', '15')),

  // Whether to override that figure with the pace actually measured today.
  //
  // Off by default, and deliberately so. A measured median is only better than
  // the clinic's own number once the day has real consultations behind it; a
  // handful of quick call-ins early on produces a confident-looking figure that
  // is far too optimistic, and the desk repeats it to patients. Turn this on
  // once the clinic is happy the measured number matches the room.
  useMeasuredPace: optional('USE_MEASURED_PACE', 'false').toLowerCase() === 'true',


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
    // Optional: leave unset until Meta approves the template and the heads-up
    // reminder simply stays off, rather than failing a send on every call-in.
    templateHeadsUp: optional('WHATSAPP_TEMPLATE_HEADS_UP', ''),
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

// A malformed recovery hash would otherwise surface as a 500 at the exact
// moment someone locked out of the clinic tries to use it. The most likely
// mistake by far is pasting the code where the hash belongs, so say that.
if (env.staffRecoveryCodeHash) {
  const parts = env.staffRecoveryCodeHash.split('$');

  if (parts.length !== 3 || parts[0] !== 'scrypt' || parts[2].length !== 128) {
    problems.push(
      '  STAFF_RECOVERY_CODE_HASH is malformed - it must be the ' +
        '`scrypt$<salt>$<hash>` line printed by `npm run generate-recovery`, ' +
        'not the recovery code itself'
    );
  }
}

if (!Number.isInteger(env.reminderLeadPatients) || env.reminderLeadPatients < 0) {
  problems.push('  REMINDER_LEAD_PATIENTS must be a whole number of patients (0 disables it)');
}

if (!Number.isFinite(env.avgConsultMinutes) || env.avgConsultMinutes <= 0) {
  problems.push('  AVG_CONSULT_MINUTES must be a positive number');
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
