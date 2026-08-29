import test from 'node:test'
import assert from 'node:assert'
import {
  consultMinutes,
  csvFilename,
  formatMinutes,
  summariseDay,
  timeInClinicMinutes,
  toCsv,
  waitedMinutes,
} from '../src/lib/report.js'

const at = (hhmm) => `2026-08-29T${hhmm}:00.000Z`

const token = (number, status, created, calledIn = null, overrides = {}) => ({
  id: `id-${number}`,
  token_number: number,
  patient_name: `Patient ${number}`,
  patient_phone: `90000000${String(number).padStart(2, '0')}`,
  status,
  created_at: created,
  called_in_at: calledIn,
  completed_at: null,
  ...overrides,
})

test('a wait is the gap between being issued a token and being called', () => {
  assert.equal(waitedMinutes(token(1, 'done', at('04:30'), at('05:00'))), 30)
})

test('a patient never called in has no wait to report', () => {
  // A no-show was not kept waiting, and printing a number here would read as
  // though the clinic had left them sitting.
  assert.equal(waitedMinutes(token(1, 'no_show', at('04:30'))), null)
})

test('long waits read as hours and minutes', () => {
  assert.equal(formatMinutes(30), '30m')
  assert.equal(formatMinutes(90), '1h 30m')
  assert.equal(formatMinutes(null), '-')
})

test('the day summary counts every outcome', () => {
  const summary = summariseDay([
    token(1, 'done', at('04:30'), at('04:40')),
    token(2, 'done', at('04:35'), at('04:55')),
    token(3, 'no_show', at('04:40')),
    token(4, 'waiting', at('05:00')),
    token(5, 'in_progress', at('05:05'), at('05:30')),
  ])

  assert.equal(summary.total, 5)
  assert.equal(summary.seen, 2)
  assert.equal(summary.noShow, 1)
  assert.equal(summary.open, 2)
  assert.equal(summary.firstTokenAt, at('04:30'))
  assert.equal(summary.lastTokenAt, at('05:05'))
})

test('one patient kept all day does not make the whole day look bad', () => {
  // A mean would report 47 minutes here; only one patient waited that long.
  const summary = summariseDay([
    token(1, 'done', at('04:30'), at('04:35')),
    token(2, 'done', at('04:35'), at('04:41')),
    token(3, 'done', at('04:40'), at('04:45')),
    token(4, 'done', at('04:45'), at('07:45')),
  ])

  assert.equal(summary.medianWait, 6)
  assert.equal(summary.longestWait, 180)
})

test('an empty day summarises without dividing by zero', () => {
  const summary = summariseDay([])

  assert.equal(summary.total, 0)
  assert.equal(summary.medianWait, null)
  assert.equal(summary.longestWait, null)
  assert.equal(summary.firstTokenAt, null)
})

test('the csv carries a header and one row per patient, ordered by token', () => {
  const csv = toCsv([
    token(2, 'done', at('04:35'), at('04:55')),
    token(1, 'no_show', at('04:30')),
  ])
  const lines = csv.split('\n')

  assert.equal(lines.length, 3)
  assert.ok(lines[0].startsWith('"Token","Name","Phone"'))
  assert.ok(lines[1].includes('"1"'), 'rows are not ordered by token number')
  assert.ok(lines[1].includes('"No show"'))
  assert.ok(lines[2].includes('"20"'), 'the wait was not written')
})

test('a name containing a comma or quote does not break the columns', () => {
  const csv = toCsv([
    token(1, 'done', at('04:30'), at('04:40'), {
      patient_name: 'Sharma, Rakesh "Raju"',
    }),
  ])

  assert.ok(csv.includes('"Sharma, Rakesh ""Raju"""'))
  assert.equal(csv.split('\n').length, 2)
})

test('a name that looks like a formula is not executed by a spreadsheet', () => {
  // Excel and Sheets run a cell beginning with = as a formula on open.
  const csv = toCsv([
    token(1, 'done', at('04:30'), at('04:40'), {
      patient_name: '=HYPERLINK("http://evil.test")',
    }),
  ])

  assert.ok(csv.includes('"\'=HYPERLINK'), 'the formula was left executable')
})

test('the export is named for the clinic and the IST day', () => {
  // 8:30pm UTC is already the 30th in Kolkata, and the file must say so.
  assert.equal(
    csvFilename('dev-eye-care', new Date('2026-08-29T20:30:00Z')),
    'dev-eye-care-2026-08-30.csv'
  )
})

test('time with the doctor is measured from being called to being done', () => {
  const seen = token(1, 'done', at('04:30'), at('04:45'), {
    completed_at: at('05:00'),
  })

  assert.equal(consultMinutes(seen), 15)
  assert.equal(timeInClinicMinutes(seen), 30)
  assert.equal(waitedMinutes(seen), 15)
})

test('a visit finished before completed_at existed is not counted as zero', () => {
  // Older rows have no completion time. Treating that as a zero-minute
  // consultation would drag the clinic average towards nothing.
  const legacy = token(1, 'done', at('04:30'), at('04:45'))

  assert.equal(consultMinutes(legacy), null)
  assert.equal(timeInClinicMinutes(legacy), null)

  const summary = summariseDay([legacy])

  assert.equal(summary.medianConsult, null)
  assert.equal(summary.measuredVisits, 0)
})

test('the day summary reports typical consult and total clinic time', () => {
  const summary = summariseDay([
    token(1, 'done', at('04:30'), at('04:35'), { completed_at: at('04:45') }),
    token(2, 'done', at('04:35'), at('04:45'), { completed_at: at('04:55') }),
    token(3, 'done', at('04:40'), at('04:55'), { completed_at: at('05:10') }),
    token(4, 'no_show', at('04:45')),
  ])

  assert.equal(summary.medianConsult, 10)
  assert.equal(summary.medianTimeInClinic, 20)
  assert.equal(summary.measuredVisits, 3)
})

test('the csv carries the new timing columns', () => {
  const csv = toCsv([
    token(1, 'done', at('04:30'), at('04:45'), { completed_at: at('05:00') }),
  ])
  const lines = csv.split('\n')

  assert.ok(lines[0].includes('"With doctor (min)"'))
  assert.ok(lines[0].includes('"In clinic (min)"'))
  assert.ok(lines[1].includes('"15"'), 'consult length missing')
  assert.ok(lines[1].includes('"30"'), 'time in clinic missing')
})
