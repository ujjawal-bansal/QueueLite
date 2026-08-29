const { TEST_PASSCODE } = require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { getIstDateString, addIstDays } = require('../src/utils/time');

const supabase = createFakeSupabase();
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

test('the first patient of the day is number one', async () => {
  const first = await addPatient('First');

  assert.equal(first.body.data.token_number, 1);
  assert.equal(first.body.data.token_day, getIstDateString());
});

test('numbering climbs through the day without repeating', async () => {
  for (let expected = 2; expected <= 12; expected += 1) {
    const created = await addPatient(`Patient ${expected}`);

    assert.equal(created.body.data.token_number, expected);
  }

  const numbers = supabase.db.tokens.map((t) => t.token_number);

  assert.equal(numbers.length, new Set(numbers).size, 'a number was reused');
});

test('a new day restarts at one, however busy yesterday was', async () => {
  // The bug this replaces: yesterday ended at 33 and every patient the next
  // morning was handed 34, because the maximum was read over a window that
  // still contained yesterday.
  supabase.db.tokens.length = 0;

  const yesterday = addIstDays(-1);

  for (let number = 1; number <= 33; number += 1) {
    supabase.db.tokens.push({
      id: `yesterday-${number}`,
      clinic_id: 'c1',
      token_day: yesterday,
      token_number: number,
      patient_name: `Yesterday ${number}`,
      patient_phone: '9876543210',
      status: 'done',
      created_at: `${yesterday}T06:00:00.000Z`,
      called_in_at: `${yesterday}T06:10:00.000Z`,
      completed_at: `${yesterday}T06:20:00.000Z`,
      queue_position: null,
      heads_up_sent_at: null,
      turn_notified_at: null,
      follow_up_due_on: null,
      follow_up_note: null,
      follow_up_status: null,
    });
  }

  const today = await addPatient('New Morning');

  assert.equal(today.body.data.token_number, 1, "the new day continued yesterday's numbering");
  assert.equal(today.body.data.token_day, getIstDateString());
});

test("yesterday's patients are not in today's queue", async () => {
  const queue = await api('/api/clinics/test-clinic/queue/today');

  assert.equal(queue.body.data.tokens.length, 1);
  assert.equal(queue.body.data.tokens[0].patient_name, 'New Morning');
  assert.equal(queue.body.data.total_today, 1);
});

test('two entries landing together take different numbers', async () => {
  // The unique index refuses the second, and the API reads again rather than
  // handing two patients the same number.
  supabase.setCollideOnceOnCreate(true);

  const created = await addPatient('Simultaneous');

  assert.equal(created.status, 201);

  const todaysNumbers = supabase.db.tokens
    .filter((t) => t.token_day === getIstDateString())
    .map((t) => t.token_number);

  assert.equal(
    todaysNumbers.length,
    new Set(todaysNumbers).size,
    `two patients hold the same number: ${todaysNumbers.join(', ')}`
  );
});
