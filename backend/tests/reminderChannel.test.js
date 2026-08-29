require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');

const claims = [];
const sends = [];
let canSendHeadsUp = false;

const queuePath = require.resolve('../src/services/queueService');
const realQueue = require(queuePath);

require.cache[queuePath].exports = {
  ...realQueue,
  getQueueState: async () => ({
    tokens: [
      { id: 'a', token_number: 1, status: 'waiting', patient_phone: '9000000001', turn_notified_at: null, heads_up_sent_at: null },
      { id: 'b', token_number: 2, status: 'waiting', patient_phone: '9000000002', turn_notified_at: null, heads_up_sent_at: null },
      { id: 'c', token_number: 3, status: 'waiting', patient_phone: '9000000003', turn_notified_at: null, heads_up_sent_at: null },
    ],
    current_token_number: null,
  }),
  claimReminder: async (tokenId, kind) => {
    claims.push(`${tokenId}:${kind}`);
    return true;
  },
  releaseReminder: async () => {},
};

const notifierPath = require.resolve('../src/services/notifier');
require.cache[notifierPath] = {
  id: notifierPath,
  filename: notifierPath,
  loaded: true,
  exports: {
    notifyYourTurn: async ({ tokenNumber }) => {
      sends.push(`your_turn:${tokenNumber}`);
      return true;
    },
    notifyHeadsUp: async ({ tokenNumber }) => {
      sends.push(`heads_up:${tokenNumber}`);
      return true;
    },
    get canSendHeadsUp() {
      return canSendHeadsUp;
    },
  },
};

const { runReminders } = require('../src/services/reminderService');

test.beforeEach(() => {
  claims.length = 0;
  sends.length = 0;
});

test('with no approved heads-up template, nobody is claimed for one', async () => {
  canSendHeadsUp = false;

  const result = await runReminders({ id: 'clinic', name: 'Dev Eye Care' });

  // Only the patient who is next is touched. Crucially, #2 and #3 are not
  // marked as reminded - the desk would otherwise show "Reminded" beside a
  // patient who was never messaged.
  assert.deepEqual(sends, ['your_turn:1']);
  assert.ok(!claims.some((claim) => claim.startsWith('b:')));
  assert.ok(!claims.some((claim) => claim.startsWith('c:')));
  assert.deepEqual(result, { sent: 1, due: 1 });
});

test('once the template is approved the nudge goes out', async () => {
  canSendHeadsUp = true;

  const result = await runReminders({ id: 'clinic', name: 'Dev Eye Care' });

  // Sent in parallel, so compare the set rather than the order.
  assert.deepEqual(
    [...sends].sort(),
    ['heads_up:2', 'heads_up:3', 'your_turn:1']
  );
  assert.deepEqual(result, { sent: 3, due: 3 });
});
