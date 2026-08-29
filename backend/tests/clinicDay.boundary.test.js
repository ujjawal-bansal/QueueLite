require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const { getIstTodayUtcRange } = require('../src/utils/time');

/**
 * The API and the database must agree on when a clinic day begins.
 *
 * They did not. Three patients arriving just after IST midnight were all issued
 * the previous day's last number, because create_token's window still pointed
 * at yesterday while the API's pointed at today. Nothing failed; the numbers
 * simply collided.
 *
 * This mirrors the SQL in migration 006 - `((ts + interval '330 minutes') at
 * time zone 'UTC')::date` - and asserts the two definitions pick the same day
 * either side of the boundary.
 */
const istDateInSql = (instant) =>
  new Date(new Date(instant).getTime() + 330 * 60000).toISOString().slice(0, 10);

const istDateFromApiWindow = (instant) => {
  const { start } = getIstTodayUtcRange(new Date(instant));
  // The window opens at IST midnight, so the day it belongs to is the date of
  // the instant half a day later.
  return new Date(Date.parse(start) + 12 * 3600 * 1000).toISOString().slice(0, 10);
};

const MOMENTS = [
  ['one second before IST midnight', '2026-08-29T18:29:59.000Z'],
  ['exactly IST midnight',           '2026-08-29T18:30:00.000Z'],
  ['one second after IST midnight',  '2026-08-29T18:30:01.000Z'],
  ['the minute the bug struck',      '2026-08-29T18:30:51.000Z'],
  ['mid-morning clinic',             '2026-08-30T04:30:00.000Z'],
  ['closing time',                   '2026-08-30T12:30:00.000Z'],
  ['a month end',                    '2026-08-31T18:30:01.000Z'],
  ['a year end',                     '2026-12-31T18:30:01.000Z'],
];

for (const [label, instant] of MOMENTS) {
  test(`the API and the database agree on the clinic day: ${label}`, () => {
    assert.equal(
      istDateFromApiWindow(instant),
      istDateInSql(instant),
      `${instant} lands on different days either side of the boundary`
    );
  });
}

test('the day rolls over at IST midnight, not UTC midnight', () => {
  // 18:29:59Z is still the 29th at the clinic; one second later it is the 30th.
  assert.equal(istDateInSql('2026-08-29T18:29:59Z'), '2026-08-29');
  assert.equal(istDateInSql('2026-08-29T18:30:00Z'), '2026-08-30');

  // And UTC midnight is the middle of the clinic's night, changing nothing.
  assert.equal(istDateInSql('2026-08-29T23:59:59Z'), '2026-08-30');
  assert.equal(istDateInSql('2026-08-30T00:00:01Z'), '2026-08-30');
});

test('a token issued just after midnight starts the new day at one', () => {
  // The shape of the bug: the window used for numbering must not still contain
  // yesterday's tokens once the clinic day has turned over.
  const justAfterMidnight = new Date('2026-08-29T18:30:51Z');
  const { start, end } = getIstTodayUtcRange(justAfterMidnight);

  const yesterdaysLastToken = '2026-08-29T13:00:00Z'; // 6:30pm IST on the 29th

  assert.ok(
    yesterdaysLastToken < start,
    "yesterday's tokens are inside today's numbering window"
  );
  assert.ok(
    justAfterMidnight.toISOString() >= start &&
      justAfterMidnight.toISOString() < end,
    'a token issued now falls outside its own day'
  );
});
