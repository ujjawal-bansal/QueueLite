import test from 'node:test'
import assert from 'node:assert'
import { formatClock, formatDayDate, formatToday } from '../src/lib/datetime.js'

test('a time is rendered as the clinic clock reads it', () => {
  assert.equal(formatClock('2026-08-29T10:10:00Z'), '3:40 pm')
})

test('a missing or unusable value never reaches Intl', () => {
  // Intl throws a RangeError on an invalid date. With no guard, one malformed
  // value from the API took the whole screen down.
  for (const bad of [null, undefined, '', 'not-a-date', 'nullT06:00:00Z', {}, NaN]) {
    assert.doesNotThrow(() => formatClock(bad), `formatClock(${JSON.stringify(bad)})`)
    assert.equal(formatClock(bad), '')
  }
})

test('a follow-up date reads as a day, not a timestamp', () => {
  // en-IN abbreviates September as "Sept", which is the locale's own choice
  // and not something to override.
  assert.equal(formatDayDate('2026-09-13'), 'Sun, 13 Sept')
  assert.equal(
    formatDayDate('2026-09-13', { weekday: 'long', month: 'long' }),
    'Sunday, 13 September'
  )
})

test('a follow-up date cannot slip a day across midnight', () => {
  // Read at midday, so no browser timezone can push the label onto the day
  // before or after the one the doctor actually wrote down.
  assert.equal(formatDayDate('2026-01-01'), 'Thu, 1 Jan')
  assert.equal(formatDayDate('2026-12-31'), 'Thu, 31 Dec')
})

test('a missing follow-up date renders as nothing, not as a crash', () => {
  for (const bad of [null, undefined, '', 'garbage']) {
    assert.doesNotThrow(() => formatDayDate(bad))
    assert.equal(formatDayDate(bad), '')
  }
})

test('the heading date is the clinic day, not the browser day', () => {
  // 8:30pm UTC is already tomorrow in Kolkata.
  assert.equal(formatToday(new Date('2026-08-29T20:30:00Z')), 'Sunday, 30 Aug 2026')
  assert.equal(formatToday(new Date('2026-08-29T10:00:00Z')), 'Saturday, 29 Aug 2026')
})
