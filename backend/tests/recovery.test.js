const crypto = require('crypto');

// A recovery code must be configured before config/env is first required.
const RECOVERY_CODE = 'Xk2p-recovery-code-9fA';
const recoverySalt = 'recoverysalt1234';
process.env.STAFF_RECOVERY_CODE_HASH = `scrypt$${recoverySalt}$${crypto
  .scryptSync(RECOVERY_CODE, recoverySalt, 64)
  .toString('hex')}`;

const { TEST_PASSCODE } = require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const supabase = createFakeSupabase();
const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: supabase,
};

const app = require('../src/server');

let server;
let baseUrl;

const post = async (path, body, cookie = '') => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json().catch(() => null), response };
};

const get = async (path, cookie = '') => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });

  return { status: response.status, body: await response.json().catch(() => null) };
};

test.before(async () => {
  supabase.db.clinics.push({ id: 'c1', name: 'Dev Eye Care', slug: 'test-clinic' });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('the recovery code opens the desk when the passcode is forgotten', async () => {
  const result = await post('/api/auth/recover', { code: RECOVERY_CODE });

  assert.equal(result.status, 200);
  assert.equal(result.body.data.via, 'recovery');

  const cookie = result.response.headers.get('set-cookie').split(';')[0];
  const session = await get('/api/auth/session', cookie);

  assert.equal(session.status, 200);
  assert.equal(session.body.data.signed_in, true);
});

test('a session opened with the recovery code says so', async () => {
  // The dashboard uses this to keep telling staff the passcode still needs
  // resetting, so a clinic does not quietly run on the break-glass code.
  const result = await post('/api/auth/recover', { code: RECOVERY_CODE });
  const cookie = result.response.headers.get('set-cookie').split(';')[0];
  const session = await get('/api/auth/session', cookie);

  assert.equal(session.body.data.via, 'recovery');
});

test('an ordinary passcode sign-in is not marked as recovery', async () => {
  const result = await post('/api/auth/login', { passcode: TEST_PASSCODE });
  const cookie = result.response.headers.get('set-cookie').split(';')[0];
  const session = await get('/api/auth/session', cookie);

  assert.equal(session.body.data.via, 'passcode');
});

test('a wrong recovery code is refused and issues no session', async () => {
  const result = await post('/api/auth/recover', { code: 'not-the-code' });

  assert.equal(result.status, 401);
  assert.equal(result.response.headers.get('set-cookie'), null);
});

test('an empty or missing code is refused rather than crashing', async () => {
  assert.equal((await post('/api/auth/recover', { code: '' })).status, 401);
  assert.equal((await post('/api/auth/recover', {})).status, 401);
  assert.equal((await post('/api/auth/recover', { code: null })).status, 401);
  assert.equal((await post('/api/auth/recover', { code: 42 })).status, 401);
});

test('the staff passcode is not accepted as a recovery code, or the reverse', async () => {
  assert.equal((await post('/api/auth/recover', { code: TEST_PASSCODE })).status, 401);
  assert.equal((await post('/api/auth/login', { passcode: RECOVERY_CODE })).status, 401);
});

test('the recovery code does not leak through the failure message', async () => {
  const result = await post('/api/auth/recover', { code: 'wrong' });

  assert.equal(result.body.error, 'Incorrect recovery code');
  assert.ok(!JSON.stringify(result.body).includes(RECOVERY_CODE));
});
