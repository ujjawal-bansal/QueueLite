require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const { toE164 } = require('../src/services/notifier/whatsapp');

test('a bare 10-digit Indian number gets the country code', () => {
  assert.equal(toE164('9876543210'), '919876543210');
});

test('formatting characters are stripped', () => {
  assert.equal(toE164('98765 43210'), '919876543210');
  assert.equal(toE164('+91 98765-43210'), '919876543210');
});

test('an already-prefixed number is left alone', () => {
  assert.equal(toE164('919876543210'), '919876543210');
});

test('leading zeros are dropped', () => {
  assert.equal(toE164('0919876543210'), '919876543210');
});
