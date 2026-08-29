// This file is about the measuring path, which is opt-in. Set before
// helpers/env so dotenv leaves it alone.
process.env.USE_MEASURED_PACE = 'true';

require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const {
  getMinutesPerPatient,
  estimateReadyAt,
  isAfterClosing,
} = require('../src/services/queueService');
const { formatIstClock } = require('../src/utils/time');

const clinic = { avg_consult_minutes: 15 };
const base = Date.parse('2026-08-29T04:30:00Z'); // 10:00 am IST, when the clinic opens

// Tokens called in at the given minute offsets from opening.
const calledAt = (...offsets) =>
  offsets.map((minutes, index) => ({
    id: `id-${index}`,
    token_number: index + 1,
    status: 'done',
    called_in_at: new Date(base + minutes * 60000).toISOString(),
  }));

test('with measuring on but nothing to measure, the clinic figure stands', () => {
  const pace = getMinutesPerPatient(calledAt(0, 4), clinic);

  assert.equal(pace.measured, false);
  assert.equal(pace.source, 'default');
  assert.equal(pace.minutesPerPatient, 15);
});

test('recent days answer for the morning, before today can', () => {
  // The gap this closes: every patient issued a token before the third call-in
  // used to be quoted the clinic's configured guess.
  const history = { minutesPerPatient: 4.5, samples: 120 };
  const pace = getMinutesPerPatient(calledAt(0, 4), clinic, history);

  assert.equal(pace.source, 'history');
  assert.equal(pace.measured, true);
  assert.equal(pace.minutesPerPatient, 4.5);
});

test('today overrules recent days the moment it has enough to say', () => {
  // A day running at half its usual speed must not keep quoting last week.
  const history = { minutesPerPatient: 12, samples: 120 };
  const pace = getMinutesPerPatient(calledAt(0, 4, 8, 12, 16), clinic, history);

  assert.equal(pace.source, 'today');
  assert.equal(pace.minutesPerPatient, 4);
});

test('history is skipped when it holds no usable figure', () => {
  const pace = getMinutesPerPatient(calledAt(0, 4), clinic, { minutesPerPatient: 0 });

  assert.equal(pace.source, 'default');
  assert.equal(pace.minutesPerPatient, 15);
});

test('the measured pace comes from the gaps between call-ins', () => {
  const pace = getMinutesPerPatient(calledAt(0, 4, 8, 12, 16), clinic);

  assert.equal(pace.measured, true);
  assert.equal(pace.source, 'today');
  assert.equal(pace.minutesPerPatient, 4);
});

test('a lunch break is not averaged in as a very slow patient', () => {
  // Four four-minute consults, an hour's break, then three more.
  const pace = getMinutesPerPatient(
    calledAt(0, 4, 8, 12, 72, 76, 80, 84),
    clinic
  );

  assert.equal(pace.measured, true);
  assert.equal(pace.minutesPerPatient, 4);
});

test('one long consult does not drag every estimate up', () => {
  const pace = getMinutesPerPatient(calledAt(0, 5, 10, 35, 40, 45), clinic);

  // The median holds at 5 where a mean would report 9.
  assert.equal(pace.minutesPerPatient, 5);
});

test('tokens with no call-in time are ignored', () => {
  const tokens = [
    ...calledAt(0, 5, 10, 15),
    { id: 'waiting-1', token_number: 90, status: 'waiting', called_in_at: null },
  ];

  const pace = getMinutesPerPatient(tokens, clinic);

  assert.equal(pace.minutesPerPatient, 5);
});

test('a clinic with no configured average falls back to the env default', () => {
  const pace = getMinutesPerPatient([], {});

  assert.equal(pace.measured, false);
  assert.equal(pace.minutesPerPatient, 15);
});

test('the ready-at estimate is the wait rendered as a clinic clock time', () => {
  const readyAt = estimateReadyAt(40, 5, base);

  assert.equal(readyAt, new Date(base + 200 * 60000).toISOString());
  assert.equal(formatIstClock(readyAt), '1:20 pm');
});

test('nobody ahead means ready now', () => {
  assert.equal(estimateReadyAt(0, 5, base), new Date(base).toISOString());
});

test('an estimate that lands after closing is recognised as one', () => {
  const clinic = { closes_at: '18:00:00' };
  // 10:00 am IST, plus 95 patients at 15 minutes each - long past 6 pm.
  const readyAt = estimateReadyAt(95, 15, base);

  assert.equal(isAfterClosing(readyAt, clinic, new Date(base)), true);
});

test('an estimate inside opening hours is not flagged', () => {
  const clinic = { closes_at: '18:00:00' };
  const readyAt = estimateReadyAt(20, 15, base);

  assert.equal(isAfterClosing(readyAt, clinic, new Date(base)), false);
});

test('a clinic with no closing time recorded never flags an estimate', () => {
  const readyAt = estimateReadyAt(200, 15, base);

  assert.equal(isAfterClosing(readyAt, {}, new Date(base)), false);
});

test('a patient already being seen has no estimate to flag', () => {
  assert.equal(isAfterClosing(null, { closes_at: '18:00:00' }, new Date(base)), false);
});

test('running a little past closing is not worth alarming anyone about', () => {
  const clinic = { closes_at: '18:00:00' };
  // 10:00 am plus 33 patients at 15 minutes lands about 15 minutes over, which
  // is a normal end to a busy day rather than a queue that will not be seen.
  const readyAt = estimateReadyAt(33, 15, base);

  assert.equal(isAfterClosing(readyAt, clinic, new Date(base)), false);
});

test('an overnight break is never counted as one enormous consultation', () => {
  const { callInGaps } = require('../src/services/queueService');

  // Two days of call-ins in one list. Computing gaps across them would put a
  // sixteen-hour "consultation" into the median.
  const monday = calledAt(0, 5, 10);
  const tuesday = calledAt(1440, 1445, 1450);
  const gaps = callInGaps([...monday, ...tuesday]);

  // The 1430-minute overnight jump is outside the credible range and dropped,
  // leaving only the four real five-minute gaps.
  assert.deepEqual(gaps, [5, 5, 5, 5]);
});
