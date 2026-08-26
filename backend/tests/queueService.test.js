require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const {
  getQueueContext,
  countPatientsAhead,
  toPublicToken,
} = require('../src/services/queueService');

const token = (number, status) => ({
  id: `id-${number}`,
  token_number: number,
  status,
  patient_name: `Patient ${number}`,
  patient_phone: '9876543210',
  created_at: '2026-08-26T05:00:00Z',
  called_in_at: null,
});

test('now-serving is the in_progress token, waiting count excludes it', () => {
  const tokens = [
    token(1, 'done'),
    token(2, 'in_progress'),
    token(3, 'waiting'),
    token(4, 'waiting'),
    token(5, 'no_show'),
  ];

  const context = getQueueContext(tokens);

  assert.equal(context.current_token_number, 2);
  assert.equal(context.waiting_count, 2);
});

test('an empty queue reports nobody serving', () => {
  const context = getQueueContext([]);

  assert.equal(context.current_token_number, null);
  assert.equal(context.waiting_count, 0);
});

test('patients ahead counts only lower-numbered waiting tokens', () => {
  const tokens = [
    token(1, 'done'),
    token(2, 'no_show'),
    token(3, 'waiting'),
    token(4, 'waiting'),
    token(5, 'waiting'),
  ];

  // #1 and #2 already left the queue, so only #3 is ahead of #4.
  assert.equal(countPatientsAhead(tokens, token(4, 'waiting')), 1);
  assert.equal(countPatientsAhead(tokens, token(3, 'waiting')), 0);
  assert.equal(countPatientsAhead(tokens, token(5, 'waiting')), 2);
});

test('the public token shape never carries the phone number', () => {
  const publicToken = toPublicToken(token(7, 'waiting'));

  assert.equal(publicToken.token_number, 7);
  assert.equal(publicToken.patient_name, 'Patient 7');
  assert.ok(!('patient_phone' in publicToken), 'phone must not be exposed');
  assert.ok(!('clinic_id' in publicToken), 'clinic id must not be exposed');
});
