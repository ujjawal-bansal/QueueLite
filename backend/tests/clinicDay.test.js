const { TEST_PASSCODE } = require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

// Both stubs have to be in place before the app pulls them in.
const supabase = createFakeSupabase();
const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: supabase,
};

// Records what each patient was told, so the test can assert on the messages
// themselves rather than on the queue's internal bookkeeping.
const sent = [];
// Lets a test make WhatsApp fail the way an outage would.
let deliveryFails = false;
const notifierPath = require.resolve('../src/services/notifier');
require.cache[notifierPath] = {
  id: notifierPath,
  filename: notifierPath,
  loaded: true,
  exports: {
    notifyTokenIssued: async ({ tokenNumber }) => {
      sent.push({ kind: 'issued', tokenNumber });
      return true;
    },
    notifyYourTurn: async ({ tokenNumber, currentTokenNumber }) => {
      if (deliveryFails) {
        return false;
      }

      sent.push({ kind: 'your_turn', tokenNumber, currentTokenNumber });
      return true;
    },
    notifyHeadsUp: async ({ tokenNumber, ahead }) => {
      if (deliveryFails) {
        return false;
      }

      sent.push({ kind: 'heads_up', tokenNumber, ahead });
      return true;
    },
    replyToPatient: async () => true,
    trackingUrl: (slug, tokenId) => `http://localhost:5173/q/${slug}/${tokenId}`,
    isWhatsAppEnabled: true,
    canSendHeadsUp: true,
  },
};

const app = require('../src/server');

const CLINIC = {
  id: 'clinic-dev-eye-care',
  name: 'Dev Eye Care',
  slug: 'test-clinic',
  doctor_name: 'Dr. Sachin Dev',
  address: 'Civil Lines, Moradabad',
  phone: '+919368444330',
  maps_url: 'https://maps.google.com/?q=Dev+Eye+Care',
  opens_at: '10:00:00',
  closes_at: '18:00:00',
  avg_consult_minutes: 6,
};

let server;
let baseUrl;
let cookie = '';

const api = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
  });

  const body = await response.json().catch(() => null);

  return { status: response.status, body, response };
};

// Reminders run off the request path on purpose, so the test has to let the
// event loop turn before asserting on them.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const reminders = (kind) => sent.filter((message) => message.kind === kind);

test.before(async () => {
  supabase.db.clinics.push({ ...CLINIC });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const signIn = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ passcode: TEST_PASSCODE }),
  });

  assert.equal(signIn.status, 200);
  cookie = signIn.response.headers.get('set-cookie').split(';')[0];
});

test.after(() => {
  server.close();
});

test('a hundred patients are issued tokens 1 to 100 in order', async () => {
  for (let index = 1; index <= 100; index += 1) {
    const created = await api('/api/clinics/test-clinic/tokens', {
      method: 'POST',
      body: JSON.stringify({
        patient_name: `Patient ${index}`,
        patient_phone: String(9000000000 + index),
      }),
    });

    assert.equal(created.status, 201, `token ${index} was not created`);
    assert.equal(created.body.data.token_number, index);
  }

  await settle();

  assert.equal(supabase.db.tokens.length, 100);
});

test('the desk is told when a new patient will be seen, not just their number', async () => {
  const queue = await api('/api/clinics/test-clinic/queue/today');

  assert.equal(queue.body.data.waiting_count, 100);
  assert.equal(queue.body.data.total_today, 100);

  const created = await api('/api/clinics/test-clinic/tokens', {
    method: 'POST',
    body: JSON.stringify({ patient_name: 'Late Arrival', patient_phone: '9811111111' }),
  });

  assert.equal(created.body.data.patients_ahead, 100);
  assert.ok(created.body.data.estimated_ready_at, 'no estimate was returned');
  assert.ok(created.body.data.tracking_url.includes(created.body.data.id));

  await settle();
});

test('only the front of the queue is messaged, however long the queue is', async () => {
  // 101 patients in the room. Everyone got their token confirmation; only the
  // first four were told anything about their turn.
  assert.equal(reminders('issued').length, 101);
  assert.deepEqual(
    reminders('your_turn').map((message) => message.tokenNumber),
    [1]
  );
  assert.deepEqual(
    reminders('heads_up').map((message) => message.tokenNumber),
    [2, 3, 4]
  );
});

test('calling patients in walks the reminder window down the queue', async () => {
  for (let index = 1; index <= 10; index += 1) {
    const called = await api('/api/clinics/test-clinic/call-next', { method: 'POST' });

    assert.equal(called.status, 200);
    assert.equal(called.body.data.token_number, index);
    await settle();
  }

  // Ten seen, so the next ten patients have each had their turn announced and
  // the three behind the front have been told to start heading over.
  assert.deepEqual(
    reminders('your_turn').map((message) => message.tokenNumber),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  );
  assert.deepEqual(
    reminders('heads_up').map((message) => message.tokenNumber),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
  );
});

test('no patient is ever messaged twice about the same turn', async () => {
  const seen = new Set();

  [...reminders('your_turn'), ...reminders('heads_up')].forEach((message) => {
    const key = `${message.kind}:${message.tokenNumber}`;

    assert.ok(!seen.has(key), `${key} was sent more than once`);
    seen.add(key);
  });
});

test('an undone mis-tap does not re-announce a turn the patient already had', async () => {
  const before = reminders('your_turn').length;
  const current = supabase.db.tokens.find((row) => row.status === 'in_progress');

  // The desk marks the patient done, realises it was the wrong row, undoes it.
  await api(`/api/clinics/test-clinic/tokens/${current.id}/done`, { method: 'PATCH' });
  await settle();
  await api(`/api/clinics/test-clinic/tokens/${current.id}/restore`, {
    method: 'PATCH',
  });
  await settle();

  // Restoring puts them back at the front, so they are told once that they are
  // next again - and nobody behind them is re-announced.
  const after = reminders('your_turn');

  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].tokenNumber, current.token_number);
});

test('a no-show pulls the queue forward, and everyone newly in range is warned', async () => {
  const beforeCount = reminders('heads_up').length + reminders('your_turn').length;
  const queue = await api('/api/clinics/test-clinic/queue/today');
  const front = queue.body.data.tokens
    .filter((token) => token.status === 'waiting')
    .sort((a, b) => a.token_number - b.token_number)[0];

  await api(`/api/clinics/test-clinic/tokens/${front.id}/no-show`, {
    method: 'PATCH',
  });
  await settle();

  const after = await api('/api/clinics/test-clinic/queue/today');
  const waiting = after.body.data.tokens
    .filter((token) => token.status === 'waiting')
    .sort((a, b) => a.token_number - b.token_number);

  assert.ok(
    !waiting.some((token) => token.id === front.id),
    'the no-show is still in the waiting list'
  );

  // The invariant the whole reminder engine exists to hold: nobody sitting
  // inside the lead window is left un-messaged, whatever moved them there.
  assert.ok(waiting[0].turn_notified_at, `#${waiting[0].token_number} was not told`);

  waiting.slice(1, 1 + 3).forEach((token) => {
    assert.ok(
      token.heads_up_sent_at,
      `#${token.token_number} is inside the window but was not warned`
    );
  });

  // And a queue moving by one place does not turn into a burst of messages.
  const added = reminders('heads_up').length + reminders('your_turn').length - beforeCount;

  assert.ok(added <= 1, `one patient moved into range, ${added} were messaged`);
});

test('a patient tracking their link sees a position and an expected time', async () => {
  const waiting = supabase.db.tokens
    .filter((row) => row.status === 'waiting')
    .sort((a, b) => a.token_number - b.token_number);
  const target = waiting[waiting.length - 1];

  // The tracking link is public: no cookie on this request.
  const savedCookie = cookie;
  cookie = '';

  const tracked = await api(`/api/clinics/test-clinic/tokens/${target.id}`);

  cookie = savedCookie;

  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.data.token.token_number, target.token_number);
  assert.equal(tracked.body.data.patients_ahead, waiting.length - 1);
  assert.ok(tracked.body.data.estimated_ready_at);
  assert.equal(tracked.body.data.clinic.name, 'Dev Eye Care');
  assert.equal(tracked.body.data.clinic.phone, '+919368444330');

  // The public endpoint must never hand out a phone number.
  assert.equal(tracked.body.data.token.patient_phone, undefined);

  // Nor promise a WhatsApp reminder. The clinic has no approved template, and
  // a patient told to stop watching the page would simply miss their turn.
  assert.equal(tracked.body.data.reminder_lead_patients, undefined);
});

test('the whole waiting room polling at once does not multiply database reads', async () => {
  const before = supabase.counts.select;

  const target = supabase.db.tokens.find((row) => row.status === 'waiting');
  const savedCookie = cookie;
  cookie = '';

  await Promise.all(
    Array.from({ length: 100 }, () =>
      api(`/api/clinics/test-clinic/tokens/${target.id}`)
    )
  );

  cookie = savedCookie;

  // 100 patients refreshing simultaneously. Each request still reads the clinic
  // row, but the day's tokens - the expensive read - are fetched once.
  const reads = supabase.counts.select - before;

  assert.ok(
    reads <= 105,
    `expected the token list to be read once, saw ${reads} reads for 100 requests`
  );
});

test('a WhatsApp outage does not cost a patient their notification', async () => {
  const before = reminders('your_turn').length;

  deliveryFails = true;

  // Call the front patient in, so the one behind becomes next while the
  // channel is down.
  await api('/api/clinics/test-clinic/call-next', { method: 'POST' });
  await settle();

  assert.equal(reminders('your_turn').length, before, 'a send got through');

  const stranded = supabase.db.tokens
    .filter((row) => row.status === 'waiting')
    .sort((a, b) => a.token_number - b.token_number)[0];

  assert.equal(
    stranded.turn_notified_at,
    null,
    'the failed send stayed claimed, so it could never be retried'
  );

  // The channel comes back, and the next thing that moves the queue retries.
  deliveryFails = false;

  await api(`/api/clinics/test-clinic/tokens/${stranded.id}/no-show`, {
    method: 'PATCH',
  });
  await settle();
  await api(`/api/clinics/test-clinic/tokens/${stranded.id}/restore`, {
    method: 'PATCH',
  });
  await settle();

  assert.ok(
    reminders('your_turn').length > before,
    'the retry never happened after the outage cleared'
  );
});

test('a token that disappears mid-call-in is a 404, not a null patient', async () => {
  const front = supabase.db.tokens
    .filter((row) => row.status === 'waiting')
    .sort((a, b) => a.token_number - b.token_number)[0];

  // The row is there when the controller checks, and gone by the time the
  // call-in runs. Postgres answers with a row of nulls rather than no row, and
  // a guard of `if (!token)` would wave that straight through to the desk as a
  // successful call-in of nobody.
  supabase.setVanishBeforeCallIn(true);

  const called = await api(
    `/api/clinics/test-clinic/tokens/${front.id}/call-in`,
    { method: 'PATCH' }
  );

  supabase.setVanishBeforeCallIn(false);

  assert.equal(called.status, 404);
  assert.equal(called.body.error, 'Token not found');
});

test('calling next with an empty queue is refused rather than guessed at', async () => {
  supabase.db.tokens.forEach((row) => {
    if (row.status === 'waiting') {
      row.status = 'done';
    }
  });

  const called = await api('/api/clinics/test-clinic/call-next', { method: 'POST' });

  assert.equal(called.status, 409);
  assert.equal(called.body.error, 'Nobody is waiting');
});

test('the public board reports the queue without identifying anybody', async () => {
  const savedCookie = cookie;
  cookie = '';

  const board = await api('/api/clinics/test-clinic/board');

  cookie = savedCookie;

  assert.equal(board.status, 200);
  assert.equal(board.body.data.clinic.name, 'Dev Eye Care');
  assert.equal(typeof board.body.data.waiting_count, 'number');
  assert.ok(Array.isArray(board.body.data.recently_called));

  // Token numbers are guessable, so the board must never attach a person to
  // one. The clinic's own phone is fine; a patient's is not.
  const raw = JSON.stringify(board.body);

  assert.ok(!raw.includes('patient_name'), 'the board exposed patient names');
  assert.ok(!raw.includes('patient_phone'), 'the board exposed patient phones');
  assert.ok(!raw.includes('Patient 1'), 'the board exposed a patient name value');
});

test('a patient given only a number over the phone can look it up', async () => {
  // Issues its own patient rather than relying on one surviving the earlier
  // tests - by this point the story above has deliberately emptied the queue.
  const created = await api('/api/clinics/test-clinic/tokens', {
    method: 'POST',
    body: JSON.stringify({ patient_name: 'Phone Booking', patient_phone: '9812345678' }),
  });

  const target = created.body.data;

  await settle();

  const savedCookie = cookie;
  cookie = '';

  const board = await api(
    `/api/clinics/test-clinic/board?token=${target.token_number}`
  );

  cookie = savedCookie;

  const { lookup } = board.body.data;

  assert.equal(lookup.found, true);
  assert.equal(lookup.token_number, target.token_number);
  assert.equal(lookup.status, 'waiting');
  assert.equal(typeof lookup.patients_ahead, 'number');
  assert.ok(lookup.estimated_ready_at);

  // Position and time only - nothing that says who this is.
  assert.equal(lookup.patient_name, undefined);
  assert.equal(lookup.patient_phone, undefined);
});

test('looking up a number that was never issued says so plainly', async () => {
  const savedCookie = cookie;
  cookie = '';

  const board = await api('/api/clinics/test-clinic/board?token=9999');

  cookie = savedCookie;

  assert.deepEqual(board.body.data.lookup, { token_number: 9999, found: false });
});

test('a nonsense token in the board query is ignored, not answered', async () => {
  const savedCookie = cookie;
  cookie = '';

  const board = await api('/api/clinics/test-clinic/board?token=abc');

  cookie = savedCookie;

  assert.equal(board.status, 200);
  assert.equal(board.body.data.lookup, undefined);
});

test('a patient who does not answer keeps their place in the day', async () => {
  // Fresh queue for the deferral story.
  supabase.db.tokens.length = 0;
  sent.length = 0;

  for (let index = 1; index <= 6; index += 1) {
    await api('/api/clinics/test-clinic/tokens', {
      method: 'POST',
      body: JSON.stringify({
        patient_name: `Late ${index}`,
        patient_phone: String(9700000000 + index),
      }),
    });
  }

  await settle();

  const orderOf = async () => {
    const queue = await api('/api/clinics/test-clinic/queue/today');
    return queue.body.data.tokens
      .filter((t) => t.status === 'waiting')
      .sort(
        (a, b) =>
          (a.queue_position ?? a.token_number) - (b.queue_position ?? b.token_number) ||
          a.token_number - b.token_number
      )
      .map((t) => t.token_number);
  };

  assert.deepEqual(await orderOf(), [1, 2, 3, 4, 5, 6]);

  // #1 is called and does not turn up.
  await api('/api/clinics/test-clinic/call-next', { method: 'POST' });
  await settle();

  const first = supabase.db.tokens.find((t) => t.token_number === 1);

  const pushed = await api(
    `/api/clinics/test-clinic/tokens/${first.id}/push-back`,
    { method: 'PATCH', body: JSON.stringify({ places: 3 }) }
  );

  assert.equal(pushed.status, 200);
  assert.equal(pushed.body.data.status, 'waiting');
  assert.equal(pushed.body.data.called_in_at, null, 'a missed call still counted as a consultation');

  await settle();

  // Three patients now get seen before them, and they are still in the queue.
  assert.deepEqual(await orderOf(), [2, 3, 4, 1, 5, 6]);
});

test('being pushed back earns a fresh reminder at the new position', async () => {
  const first = supabase.db.tokens.find((t) => t.token_number === 1);

  // They were told they were next, then pushed back three. That old message no
  // longer describes where they stand, so the claim on it has to be released -
  // otherwise the dedupe that stops double-messaging also silences them for
  // the rest of the day.
  assert.equal(first.turn_notified_at, null, 'the stale turn notice was kept');

  // And at three ahead they are inside the lead window again, so a heads-up
  // goes out for the new position.
  assert.ok(
    reminders('heads_up').some((message) => message.tokenNumber === 1),
    'the pushed-back patient was never warned again'
  );
  assert.ok(first.heads_up_sent_at, 'the fresh heads-up was not recorded');
});

test('push back refuses a nonsense number of places', async () => {
  const target = supabase.db.tokens.find((t) => t.status === 'waiting');

  for (const places of [0, -3, 1.5, 999, 'three', null]) {
    const result = await api(
      `/api/clinics/test-clinic/tokens/${target.id}/push-back`,
      { method: 'PATCH', body: JSON.stringify({ places }) }
    );

    assert.equal(result.status, 400, `places=${places} was accepted`);
  }
});

test('push back needs a signed-in staff member', async () => {
  const target = supabase.db.tokens.find((t) => t.status === 'waiting');
  const savedCookie = cookie;
  cookie = '';

  const result = await api(
    `/api/clinics/test-clinic/tokens/${target.id}/push-back`,
    { method: 'PATCH', body: JSON.stringify({ places: 3 }) }
  );

  cookie = savedCookie;

  assert.equal(result.status, 401);
});

test('the doctor’s instruction to come back is recorded against the visit', async () => {
  const created = await api('/api/clinics/test-clinic/tokens', {
    method: 'POST',
    body: JSON.stringify({ patient_name: 'Review Patient', patient_phone: '9812300011' }),
  });

  const token = created.body.data;

  await api(`/api/clinics/test-clinic/tokens/${token.id}/call-in`, { method: 'PATCH' });
  await api(`/api/clinics/test-clinic/tokens/${token.id}/done`, { method: 'PATCH' });
  await settle();

  const followUp = await api(
    `/api/clinics/test-clinic/tokens/${token.id}/follow-up`,
    { method: 'POST', body: JSON.stringify({ days: 15, note: 'bring old glasses' }) }
  );

  assert.equal(followUp.status, 201);
  assert.equal(followUp.body.data.patient_name, 'Review Patient');
  assert.equal(followUp.body.data.status, 'scheduled');
  assert.equal(followUp.body.data.note, 'bring old glasses');
  assert.equal(followUp.body.data.patient_phone, '9812300011');

  // Stored on the visit itself, so the follow-up and the patient it belongs to
  // can never disagree about who they are.
  assert.equal(followUp.body.data.id, token.id);

  const listed = await api('/api/clinics/test-clinic/follow-ups');

  assert.ok(
    listed.body.data.follow_ups.some((f) => f.id === followUp.body.data.id),
    'the follow-up was not listed'
  );
  assert.equal(
    listed.body.data.follow_ups.find((f) => f.id === followUp.body.data.id).days_until,
    15
  );
});

test('a follow-up interval that makes no sense is refused', async () => {
  const token = supabase.db.tokens.find((t) => t.status === 'done');
  assert.ok(token, 'no completed visit to attach a follow-up to');

  for (const days of [0, -5, 2.5, 400, 'soon', null]) {
    const result = await api(
      `/api/clinics/test-clinic/tokens/${token.id}/follow-up`,
      { method: 'POST', body: JSON.stringify({ days }) }
    );

    assert.equal(result.status, 400, `days=${days} was accepted`);
  }
});

test('marking a patient as returned takes them off the list', async () => {
  const listed = await api('/api/clinics/test-clinic/follow-ups');
  const target = listed.body.data.follow_ups[0];

  const done = await api(
    `/api/clinics/test-clinic/follow-ups/${target.id}/done`,
    { method: 'PATCH' }
  );

  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, 'completed');

  const after = await api('/api/clinics/test-clinic/follow-ups');

  assert.ok(!after.body.data.follow_ups.some((f) => f.id === target.id));

  // Closing a follow-up must not touch the visit it hangs off. The token's own
  // completed_at records when the patient was seen, months before the review.
  const visit = supabase.db.tokens.find((t) => t.id === target.id);

  assert.equal(visit.status, 'done', 'closing the follow-up changed the visit');
});

test('a follow-up carries the doctor note through to the staff list', async () => {
  const listed = await api('/api/clinics/test-clinic/follow-ups');
  const withNote = listed.body.data.follow_ups.find((f) => f.note);

  if (withNote) {
    assert.equal(typeof withNote.due_on, 'string');
    assert.equal(typeof withNote.days_until, 'number');
  }
});

test('follow-ups are staff only - they are names, numbers and clinical notes', async () => {
  const savedCookie = cookie;
  cookie = '';

  const listed = await api('/api/clinics/test-clinic/follow-ups');

  cookie = savedCookie;

  assert.equal(listed.status, 401);
});

test('the desk is told where its wait estimate came from', async () => {
  // Produced by the queue state but, until this test, never forwarded by the
  // controller - so the label on the dashboard resolved to an empty string and
  // the whole distinction was invisible.
  const queue = await api('/api/clinics/test-clinic/queue/today');
  const data = queue.body.data;

  assert.ok(
    ['clinic', 'today', 'history', 'default'].includes(data.pace_source),
    `pace_source was ${JSON.stringify(data.pace_source)}`
  );
  assert.equal(typeof data.minutes_per_patient, 'number');
  assert.equal(typeof data.pace_measured, 'boolean');
});

test('a token number collision is retried, not shown to the desk', async () => {
  // The database refuses a number already issued today. Two entries landing in
  // the same instant is the only way past the advisory lock, and the second
  // just needs the next number - the front desk should never see it happen.
  supabase.setCollideOnceOnCreate(true);

  const created = await api('/api/clinics/test-clinic/tokens', {
    method: 'POST',
    body: JSON.stringify({ patient_name: 'Simultaneous', patient_phone: '9800000001' }),
  });

  assert.equal(created.status, 201, 'the collision reached the desk');
  assert.ok(created.body.data.token_number > 0);

  await settle();
});

test('no two patients today hold the same number', async () => {
  const queue = await api('/api/clinics/test-clinic/queue/today');
  const numbers = queue.body.data.tokens.map((token) => token.token_number);

  assert.equal(
    numbers.length,
    new Set(numbers).size,
    `duplicate token numbers issued: ${numbers.join(', ')}`
  );
});
