const { TEST_PASSCODE } = require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { getIstDateString, addIstDays } = require('../src/utils/time');

/**
 * A database that has not had migration 006 applied yet.
 *
 * Code and migrations do not land together: the API deploys on a push and the
 * migration is run by hand afterwards. The queue has to keep working in that
 * gap, and keep numbering correctly, rather than failing on a column that is
 * not there yet.
 */
const supabase = createFakeSupabase();
supabase.setTokenDayColumn(false);

const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: supabase,
};

const notifierPath = require.resolve('../src/services/notifier');
require.cache[notifierPath] = {
  id: notifierPath,
  filename: notifierPath,
  loaded: true,
  exports: {
    notifyTokenIssued: async () => true,
    notifyYourTurn: async () => true,
    notifyHeadsUp: async () => true,
    replyToPatient: async () => true,
    trackingUrl: () => 'http://localhost/q/x/y',
    isWhatsAppEnabled: false,
    canSendHeadsUp: false,
  },
};

const app = require('../src/server');

let server;
let baseUrl;
let cookie = '';

const api = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });

  return { status: response.status, body: await response.json().catch(() => null) };
};

const addPatient = (name) =>
  api('/api/clinics/test-clinic/tokens', {
    method: 'POST',
    body: JSON.stringify({ patient_name: name, patient_phone: '9876543210' }),
  });

test.before(async () => {
  supabase.db.clinics.push({ id: 'c1', name: 'Dev Eye Care', slug: 'test-clinic' });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const signIn = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: TEST_PASSCODE }),
  });

  cookie = signIn.headers.get('set-cookie').split(';')[0];
});

test.after(() => server.close());

test('the desk still works before the migration is run', async () => {
  const created = await addPatient('Before Migration');

  assert.equal(created.status, 201, created.body?.error);
  assert.equal(created.body.data.token_number, 1);
});

test('and still numbers correctly, which is the point', async () => {
  for (let expected = 2; expected <= 5; expected += 1) {
    const created = await addPatient(`Patient ${expected}`);

    assert.equal(created.body.data.token_number, expected);
  }
});

test("yesterday's tokens do not carry into today's numbering", async () => {
  // The original bug, checked against the fallback path: an unmigrated database
  // must not repeat it.
  supabase.db.tokens.length = 0;

  const yesterday = addIstDays(-1);

  supabase.db.tokens.push({
    id: 'yesterday-33',
    clinic_id: 'c1',
    token_number: 33,
    patient_name: 'Yesterday',
    patient_phone: '9876543210',
    status: 'done',
    created_at: `${yesterday}T06:00:00.000Z`,
    called_in_at: null,
    completed_at: null,
    queue_position: null,
    heads_up_sent_at: null,
    turn_notified_at: null,
    follow_up_due_on: null,
    follow_up_note: null,
    follow_up_status: null,
  });

  const today = await addPatient('New Morning');

  assert.equal(today.body.data.token_number, 1);
});

test('the queue reads without the column too', async () => {
  const queue = await api('/api/clinics/test-clinic/queue/today');

  assert.equal(queue.status, 200);
  assert.equal(queue.body.data.tokens.length, 1);
  assert.equal(queue.body.data.tokens[0].patient_name, 'New Morning');
});

test('no token_day is written to a database that has no such column', async () => {
  const stored = supabase.db.tokens.find((t) => t.patient_name === 'New Morning');

  assert.equal(stored.token_day, undefined);
});
