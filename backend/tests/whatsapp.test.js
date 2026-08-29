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

test('a local number written behind a zero still gets its country code', () => {
  // How the number is spoken and written at a desk in Moradabad. Stripping the
  // zero after the ten-digit check would leave this with no country code.
  assert.equal(toE164('06396634403'), '916396634403');
  assert.equal(toE164('0 63966 34403'), '916396634403');
});
