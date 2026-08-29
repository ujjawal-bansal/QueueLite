// The shipped default: the clinic's own figure decides every estimate, and the
// measured pace does not override it. helpers/env pins USE_MEASURED_PACE off,
// so this file describes the behaviour a clinic actually gets out of the box.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const {
  getMinutesPerPatient,
  estimateReadyAt,
} = require('../src/services/queueService');
const { formatIstClock } = require('../src/utils/time');

const base = Date.parse('2026-08-29T04:30:00Z'); // 10:00 am IST

const calledAt = (...offsets) =>
  offsets.map((minutes, index) => ({
    id: `id-${index}`,
    token_number: index + 1,
    status: 'done',
    called_in_at: new Date(base + minutes * 60000).toISOString(),
  }));

test('the clinic figure decides, whatever today happens to look like', () => {
  // A morning of two-minute call-ins would measure a pace of 2. That is real
  // but misleading: a run of quick reviews early on says nothing about the
  // dilations booked for the afternoon, and the desk repeats the number to
  // patients as though it were a promise.
  const clinic = { avg_consult_minutes: 15 };
  const pace = getMinutesPerPatient(calledAt(0, 2, 4, 6, 8, 10, 12), clinic);

  assert.equal(pace.minutesPerPatient, 15);
  assert.equal(pace.source, 'clinic');
  assert.equal(pace.measured, false);
});

test('a clinic with no figure of its own falls back to the env default', () => {
  const pace = getMinutesPerPatient([], {});

  assert.equal(pace.minutesPerPatient, 15);
  assert.equal(pace.source, 'clinic');
});

test('history is not consulted when the figure is fixed', () => {
  const clinic = { avg_consult_minutes: 15 };
  const pace = getMinutesPerPatient([], clinic, { minutesPerPatient: 4, samples: 90 });

  assert.equal(pace.minutesPerPatient, 15);
});

test('a waiting patient is quoted fifteen minutes per patient ahead', () => {
  // Four ahead at 10:00 am is an hour, so around 11:00.
  const readyAt = estimateReadyAt(4, 15, base);

  assert.equal(formatIstClock(readyAt), '11:00 am');
});

test('the estimate scales with the queue, not with the clock', () => {
  assert.equal(formatIstClock(estimateReadyAt(1, 15, base)), '10:15 am');
  assert.equal(formatIstClock(estimateReadyAt(8, 15, base)), '12:00 pm');
  assert.equal(formatIstClock(estimateReadyAt(0, 15, base)), '10:00 am');
});
