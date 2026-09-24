// No Google sign-in configured: helpers/env pins both settings empty, so this
// holds whatever sits in the developer's own .env.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: createFakeSupabase(),
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

test('the login screen is told there is no Google button to draw', async () => {
  const body = await (await fetch(`${baseUrl}/api/auth/methods`)).json();

  assert.equal(body.data.google_client_id, null);
});

test('the Google route reports 404, not 403, when switched off', async () => {
  const response = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: 'anything' }),
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('set-cookie'), null);
});
