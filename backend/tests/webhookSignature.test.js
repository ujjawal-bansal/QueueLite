process.env.NOTIFIER = 'whatsapp';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id';
process.env.WHATSAPP_ACCESS_TOKEN = 'test-access-token';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';

require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { hasValidSignature } = require('../src/controllers/whatsappController');

const APP_SECRET = 'test-app-secret';

const makeReq = (rawBody, signature) => ({
  rawBody,
  get: (header) =>
    header.toLowerCase() === 'x-hub-signature-256' ? signature : undefined,
});

const sign = (body) =>
  'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');

test('a correctly signed payload is accepted', () => {
  const body = Buffer.from(JSON.stringify({ entry: [{ id: '1' }] }));

  assert.equal(hasValidSignature(makeReq(body, sign(body))), true);
});

test('a payload signed with the wrong secret is rejected', () => {
  const body = Buffer.from('{"entry":[]}');
  const wrong =
    'sha256=' + crypto.createHmac('sha256', 'not-the-secret').update(body).digest('hex');

  assert.equal(hasValidSignature(makeReq(body, wrong)), false);
});

test('a tampered body no longer matches its signature', () => {
  const original = Buffer.from('{"entry":[{"id":"1"}]}');
  const signature = sign(original);
  const tampered = Buffer.from('{"entry":[{"id":"2"}]}');

  assert.equal(hasValidSignature(makeReq(tampered, signature)), false);
});

test('missing signature or body is rejected', () => {
  const body = Buffer.from('{}');

  assert.equal(hasValidSignature(makeReq(body, undefined)), false);
  assert.equal(hasValidSignature(makeReq(undefined, sign(body))), false);
  assert.equal(hasValidSignature(makeReq(body, 'garbage')), false);
  assert.equal(hasValidSignature(makeReq(body, '')), false);
});
