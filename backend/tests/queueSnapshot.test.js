require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');

// queueService talks to Supabase through one module, so standing a fake in its
// place before it is first required lets the snapshot behaviour be tested
// without a database.
let queryCount = 0;
let tokens = [];
let resolveNext = null;

const builder = () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    lt: () => chain,
    order: () => chain,
    then: (onFulfilled, onRejected) => {
      queryCount += 1;

      const settle = () => ({ data: tokens, error: null });

      // A test can hold the query open to prove concurrent callers wait on the
      // same one rather than each starting their own.
      const promise = resolveNext
        ? new Promise((resolve) => {
            resolveNext = () => resolve(settle());
          })
        : Promise.resolve(settle());

      return promise.then(onFulfilled, onRejected);
    },
  };

  return chain;
};

const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { from: builder, rpc: async () => ({ data: true, error: null }) },
};

const {
  getTodayTokens,
  invalidateQueue,
} = require('../src/services/queueService');

const CLINIC_ID = 'clinic-1';

const token = (number, status) => ({
  id: `id-${number}`,
  token_number: number,
  status,
  patient_name: `Patient ${number}`,
  patient_phone: '9876543210',
  created_at: new Date().toISOString(),
  called_in_at: null,
});

test.beforeEach(() => {
  queryCount = 0;
  resolveNext = null;
  tokens = [token(1, 'in_progress'), token(2, 'waiting')];
  invalidateQueue(CLINIC_ID);
});

test('a hundred simultaneous trackers cost one database read', async () => {
  // Hold the read open so all hundred callers arrive while it is in flight -
  // which is exactly what a waiting room's polls do.
  resolveNext = () => {};

  const reads = Array.from({ length: 100 }, () => getTodayTokens(CLINIC_ID));

  await new Promise((resolve) => setImmediate(resolve));
  resolveNext();

  const results = await Promise.all(reads);

  assert.equal(queryCount, 1);
  assert.equal(results.length, 100);
  results.forEach((result) => assert.deepEqual(result, tokens));
});

test('a second read within the snapshot window is served from it', async () => {
  await getTodayTokens(CLINIC_ID);
  await getTodayTokens(CLINIC_ID);

  assert.equal(queryCount, 1);
});

test('a staff action invalidates the snapshot so the desk sees its own write', async () => {
  await getTodayTokens(CLINIC_ID);

  tokens = [...tokens, token(3, 'waiting')];
  invalidateQueue(CLINIC_ID);

  const refreshed = await getTodayTokens(CLINIC_ID);

  assert.equal(queryCount, 2);
  assert.equal(refreshed.length, 3);
});

test('a fresh read bypasses the snapshot', async () => {
  await getTodayTokens(CLINIC_ID);
  await getTodayTokens(CLINIC_ID, { fresh: true });

  assert.equal(queryCount, 2);
});

test('a failed read is not cached', async () => {
  const failing = { ...require.cache[supabasePath].exports };
  require.cache[supabasePath].exports.from = () => ({
    select: () => require.cache[supabasePath].exports.from(),
    eq: () => require.cache[supabasePath].exports.from(),
    gte: () => require.cache[supabasePath].exports.from(),
    lt: () => require.cache[supabasePath].exports.from(),
    order: () => require.cache[supabasePath].exports.from(),
    then: (onFulfilled, onRejected) =>
      Promise.resolve({ data: null, error: new Error('connection lost') }).then(
        onFulfilled,
        onRejected
      ),
  });

  await assert.rejects(getTodayTokens(CLINIC_ID));

  // Restoring the working client must produce a real read, not a cached error.
  require.cache[supabasePath].exports.from = failing.from;

  const recovered = await getTodayTokens(CLINIC_ID);

  assert.equal(recovered.length, 2);
});
