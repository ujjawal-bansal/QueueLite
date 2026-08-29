// Must be required before anything that pulls in src/config/env.js, which
// exits the process when required settings are missing.
process.env.NODE_ENV = 'test';
process.env.PORT = '3999';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CLINIC_SLUG = 'test-clinic';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SESSION_SECRET = 'a'.repeat(48);
process.env.SESSION_TTL_HOURS = '12';
process.env.NOTIFIER = 'console';

// Optional settings must be pinned too, or the suite quietly inherits whatever
// the developer happens to have in their own .env: dotenv fills in anything not
// already present, so a hash sitting in a local file would switch the recovery
// route on in tests written for it being off. Assigning rather than deleting is
// what stops dotenv refilling it, and `||` lets a test set its own first.
process.env.STAFF_RECOVERY_CODE_HASH = process.env.STAFF_RECOVERY_CODE_HASH || '';
process.env.USE_MEASURED_PACE = process.env.USE_MEASURED_PACE || 'false';
process.env.AVG_CONSULT_MINUTES = process.env.AVG_CONSULT_MINUTES || '15';
process.env.REMINDER_LEAD_PATIENTS = process.env.REMINDER_LEAD_PATIENTS || '3';
process.env.WHATSAPP_COUNTRY_CODE = '91';

const crypto = require('crypto');

const TEST_PASSCODE = 'front-desk-2026';
const salt = 'fixedsalt0123456';
const derived = crypto.scryptSync(TEST_PASSCODE, salt, 64).toString('hex');
process.env.STAFF_PASSCODE_HASH = `scrypt$${salt}$${derived}`;

module.exports = { TEST_PASSCODE };
