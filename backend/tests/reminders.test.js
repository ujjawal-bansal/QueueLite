require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const { findDueReminders } = require('../src/services/reminderService');

const token = (number, status, overrides = {}) => ({
  id: `id-${number}`,
  token_number: number,
  status,
  patient_name: `Patient ${number}`,
  patient_phone: '9876543210',
  created_at: '2026-08-29T05:00:00Z',
  called_in_at: null,
  heads_up_sent_at: null,
  turn_notified_at: null,
  ...overrides,
});

const kindsFor = (due) =>
  due.map((item) => [item.token.token_number, item.kind, item.ahead]);

test('the patient at the front is told they are next, the next few get a heads up', () => {
  const tokens = [
    token(1, 'in_progress'),
    token(2, 'waiting'),
    token(3, 'waiting'),
    token(4, 'waiting'),
    token(5, 'waiting'),
    token(6, 'waiting'),
  ];

  const due = findDueReminders(tokens, { leadPatients: 3 });

  assert.deepEqual(kindsFor(due), [
    [2, 'your_turn', 0],
    [3, 'heads_up', 1],
    [4, 'heads_up', 2],
    [5, 'heads_up', 3],
  ]);
});

test('nobody outside the lead window is messaged', () => {
  const tokens = Array.from({ length: 100 }, (unused, index) =>
    token(index + 1, 'waiting')
  );

  const due = findDueReminders(tokens, { leadPatients: 3 });

  // 100 patients in the room, four messages: this is what stops a busy morning
  // from becoming a hundred WhatsApp sends every time the queue moves.
  assert.equal(due.length, 4);
  assert.deepEqual(
    due.map((item) => item.token.token_number),
    [1, 2, 3, 4]
  );
});

test('an already-sent reminder is not repeated', () => {
  const tokens = [
    token(1, 'waiting', { turn_notified_at: '2026-08-29T05:10:00Z' }),
    token(2, 'waiting', { heads_up_sent_at: '2026-08-29T05:10:00Z' }),
    token(3, 'waiting'),
  ];

  const due = findDueReminders(tokens, { leadPatients: 3 });

  assert.deepEqual(kindsFor(due), [[3, 'heads_up', 2]]);
});

test('done and no-show tokens do not hold anyone else back a place', () => {
  const tokens = [
    token(1, 'done'),
    token(2, 'no_show'),
    token(3, 'done'),
    token(4, 'waiting'),
    token(5, 'waiting'),
  ];

  const due = findDueReminders(tokens, { leadPatients: 1 });

  // #4 is at the front despite three tokens sitting in front of it by number.
  assert.deepEqual(kindsFor(due), [
    [4, 'your_turn', 0],
    [5, 'heads_up', 1],
  ]);
});

test('a lead of zero leaves only the turn notification', () => {
  const tokens = [token(1, 'waiting'), token(2, 'waiting'), token(3, 'waiting')];

  const due = findDueReminders(tokens, { leadPatients: 0 });

  assert.deepEqual(kindsFor(due), [[1, 'your_turn', 0]]);
});

test('an out-of-order token list is still ranked by token number', () => {
  const tokens = [token(9, 'waiting'), token(2, 'waiting'), token(5, 'waiting')];

  const due = findDueReminders(tokens, { leadPatients: 1 });

  assert.deepEqual(kindsFor(due), [
    [2, 'your_turn', 0],
    [5, 'heads_up', 1],
  ]);
});

test('an empty queue is due nothing', () => {
  assert.deepEqual(findDueReminders([], { leadPatients: 3 }), []);
});
