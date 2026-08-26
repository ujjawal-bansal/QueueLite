require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const { getIstTodayUtcRange } = require('../src/utils/time');

test('IST day starts at 18:30 UTC the previous day', () => {
  const { start, end } = getIstTodayUtcRange(new Date('2026-08-26T09:00:00Z'));

  assert.equal(start, '2026-08-25T18:30:00.000Z');
  assert.equal(end, '2026-08-26T18:30:00.000Z');
});

test('a UTC instant just before IST midnight belongs to the previous IST day', () => {
  // 18:29 UTC is 23:59 IST on the 26th.
  const { start } = getIstTodayUtcRange(new Date('2026-08-26T18:29:00Z'));

  assert.equal(start, '2026-08-25T18:30:00.000Z');
});

test('a UTC instant just after IST midnight rolls to the next IST day', () => {
  // 18:31 UTC is 00:01 IST on the 27th.
  const { start } = getIstTodayUtcRange(new Date('2026-08-26T18:31:00Z'));

  assert.equal(start, '2026-08-26T18:30:00.000Z');
});

test('the window is exactly 24 hours', () => {
  const { start, end } = getIstTodayUtcRange(new Date('2026-01-15T04:00:00Z'));

  assert.equal(Date.parse(end) - Date.parse(start), 24 * 60 * 60 * 1000);
});
