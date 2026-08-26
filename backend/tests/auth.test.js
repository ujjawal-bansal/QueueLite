const { TEST_PASSCODE } = require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const {
  verifyPasscode,
  issueSession,
  readSession,
} = require('../src/services/authService');

test('the correct passcode verifies', () => {
  assert.equal(verifyPasscode(TEST_PASSCODE), true);
});

test('wrong, empty, and non-string passcodes are rejected', () => {
  assert.equal(verifyPasscode('wrong-passcode'), false);
  assert.equal(verifyPasscode(''), false);
  assert.equal(verifyPasscode(undefined), false);
  assert.equal(verifyPasscode(null), false);
  assert.equal(verifyPasscode(12345), false);
  assert.equal(verifyPasscode(`${TEST_PASSCODE} `), false);
});

test('an issued session reads back as staff', () => {
  const session = readSession(issueSession());

  assert.equal(session.role, 'staff');
  assert.equal(session.clinic, 'test-clinic');
});

test('tampered, empty, and foreign-signed tokens are rejected', () => {
  const jwt = require('jsonwebtoken');

  assert.equal(readSession(''), null);
  assert.equal(readSession('not-a-jwt'), null);
  assert.equal(readSession(`${issueSession()}x`), null);
  assert.equal(
    readSession(jwt.sign({ role: 'staff' }, 'a-different-secret-entirely')),
    null
  );
});
