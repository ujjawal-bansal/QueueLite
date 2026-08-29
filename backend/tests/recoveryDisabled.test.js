// Deliberately configures no recovery code: this file is the "no second door
// was asked for" deployment. helpers/env pins the variable empty, so this holds
// whatever sits in the developer's own .env. node:test runs each file in its
// own process, so this stays independent of recovery.test.js.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { isRecoveryEnabled, verifyRecoveryCode } = require('../src/services/authService');

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

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('with no code configured there is no second door', () => {
  assert.equal(isRecoveryEnabled(), false);
});

test('verifying a code without one configured returns false, never throws', () => {
  // The hash parser throws on malformed input by design; an absent hash must
  // take the "switched off" path before it ever gets there.
  assert.doesNotThrow(() => verifyRecoveryCode('anything'));
  assert.equal(verifyRecoveryCode('anything'), false);
  assert.equal(verifyRecoveryCode(''), false);
});

test('the recovery route reports 404, not 403', async () => {
  // A switched-off endpoint should not confirm that it exists and might work
  // with the right input.
  const response = await fetch(`${baseUrl}/api/auth/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'anything' }),
  });

  assert.equal(response.status, 404);

  const body = await response.json();

  assert.equal(body.error, 'Not found');
  assert.equal(response.headers.get('set-cookie'), null);
});
