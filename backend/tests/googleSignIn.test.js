// A deployment with Google sign-in switched on for two staff accounts. Set
// before helpers/env, which only fills these in when they are absent. node:test
// runs each file in its own process, so no other file sees them.
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.STAFF_GOOGLE_EMAILS = 'Reception@DevEyeCare.in, doctor@example.com';

require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const supabase = createFakeSupabase();
const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: supabase,
};

const { googleClient } = require('../src/services/authService');
const app = require('../src/server');

// Stands in for Google: a key pair of our own, published the way Google
// publishes its certificates. Everything else - signature, audience, issuer,
// expiry - is checked by Google's real library, not by a stub.
const KEY_ID = 'test-key';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = google.publicKey.export({ type: 'spki', format: 'pem' });

googleClient.getFederatedSignonCertsAsync = async () => ({
  certs: { [KEY_ID]: publicPem },
  format: 'PEM',
});

const idToken = (claims = {}, { key = google.privateKey } = {}) => {
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iss: 'https://accounts.google.com',
      aud: process.env.GOOGLE_CLIENT_ID,
      sub: '1234567890',
      email: 'reception@deveyecare.in',
      email_verified: true,
      iat: now,
      exp: now + 3600,
      ...claims,
    },
    key.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', keyid: KEY_ID }
  );
};

let server;
let baseUrl;

const signIn = (credential) =>
  fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  });

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('the login screen is told the client id, and never the staff list', async () => {
  const response = await fetch(`${baseUrl}/api/auth/methods`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.google_client_id, process.env.GOOGLE_CLIENT_ID);
  assert.ok(!JSON.stringify(body).includes('deveyecare'), 'staff emails must not leak');
});

test('a listed staff account gets the same staff session the passcode does', async () => {
  const response = await signIn(idToken());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.via, 'google');

  const cookie = response.headers.get('set-cookie').split(';')[0];
  const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie } });
  const sessionBody = await session.json();

  assert.equal(session.status, 200);
  assert.equal(sessionBody.data.via, 'google');
  // A shared passcode cannot say who is at the desk; this can.
  assert.equal(sessionBody.data.email, 'reception@deveyecare.in');

  // And it opens the staff API, not just the session check.
  const queue = await fetch(`${baseUrl}/api/clinics/test-clinic/queue/today`, {
    headers: { cookie },
  });

  assert.notEqual(queue.status, 401);
});

test('the list is matched without regard to case', async () => {
  // Listed as "Reception@DevEyeCare.in"; Google reports it however it likes.
  const response = await signIn(idToken({ email: 'RECEPTION@deveyecare.IN' }));

  assert.equal(response.status, 200);
});

test('a real Google account that is not on the list is refused', async () => {
  const response = await signIn(idToken({ email: 'someone@gmail.com' }));
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.match(body.error, /not on the staff list/);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('an email Google has not verified is refused, even if it is listed', async () => {
  const response = await signIn(idToken({ email_verified: false }));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('a token Google issued to some other site is refused', async () => {
  // The audience check is what stops a token from any other Google sign-in
  // being replayed here.
  const response = await signIn(idToken({ aud: 'another-site.apps.googleusercontent.com' }));

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('forged, expired, foreign-issued and missing tokens are refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  const refused = [
    idToken({}, { key: stranger.privateKey }),
    idToken({ iat: now - 7200, exp: now - 3600 }),
    idToken({ iss: 'https://evil.example.com' }),
    `${idToken()}x`,
    'not-a-token',
    '',
    undefined,
  ];

  for (const credential of refused) {
    const response = await signIn(credential);

    assert.equal(response.status, 401, `accepted ${String(credential).slice(0, 20)}`);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('the passcode still works alongside Google', async () => {
  const { TEST_PASSCODE } = require('./helpers/env');
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: TEST_PASSCODE }),
  });

  assert.equal(response.status, 200);
});
