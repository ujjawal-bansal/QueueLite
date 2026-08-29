/**
 * The end-of-day view of a clinic day.
 *
 * Everything here derives from the tokens the dashboard already holds - there
 * is no separate report endpoint, so opening the report costs nothing extra and
 * always agrees with the queue it was opened from.
 */

const STATUS_LABELS = {
  waiting: 'Waiting',
  in_progress: 'Being seen',
  done: 'Seen',
  no_show: 'No show',
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status
}

export function formatClock(instant) {
  if (!instant) {
    return ''
  }

  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(instant))
    .toLowerCase()
}

/**
 * How long a patient sat before being called, in whole minutes.
 *
 * Null for anyone never called in: a no-show has no wait to report, and
 * printing a number there would read as though they had been kept waiting.
 */
export function waitedMinutes(token) {
  if (!token.called_in_at || !token.created_at) {
    return null
  }

  const minutes = Math.round(
    (new Date(token.called_in_at) - new Date(token.created_at)) / 60000
  )

  return minutes >= 0 ? minutes : null
}

const minutesBetween = (from, to) => {
  if (!from || !to) {
    return null
  }

  const minutes = Math.round((new Date(to) - new Date(from)) / 60000)

  return minutes >= 0 ? minutes : null
}

/**
 * How long the patient was with the doctor.
 *
 * Null for any visit finished before completed_at existed, and for anyone not
 * yet seen - which is why the summary counts these separately rather than
 * treating a missing value as zero.
 */
export function consultMinutes(token) {
  return minutesBetween(token.called_in_at, token.completed_at)
}

/**
 * How long the patient was in the building altogether: from the moment they
 * were handed a token to the moment they walked out.
 */
export function timeInClinicMinutes(token) {
  return minutesBetween(token.created_at, token.completed_at)
}

export function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined) {
    return '-'
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const median = (values) => {
  if (values.length === 0) {
    return null
  }

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle]
}

/**
 * The day in numbers.
 *
 * Waits are reported as a median rather than a mean: one patient who arrived at
 * opening and was seen at closing would otherwise make the whole day look bad.
 */
export function summariseDay(tokens = []) {
  const seen = tokens.filter((token) => token.status === 'done')
  const noShow = tokens.filter((token) => token.status === 'no_show')
  const open = tokens.filter(
    (token) => token.status === 'waiting' || token.status === 'in_progress'
  )

  const waits = tokens.map(waitedMinutes).filter((value) => value !== null)

  const issuedTimes = tokens
    .map((token) => token.created_at)
    .filter(Boolean)
    .sort()

  const consults = tokens.map(consultMinutes).filter((value) => value !== null)
  const inClinic = tokens.map(timeInClinicMinutes).filter((value) => value !== null)

  return {
    total: tokens.length,
    seen: seen.length,
    noShow: noShow.length,
    open: open.length,
    medianWait: median(waits),
    longestWait: waits.length ? Math.max(...waits) : null,
    medianConsult: median(consults),
    medianTimeInClinic: median(inClinic),
    // Visits finished before completed_at existed cannot contribute, and the
    // report should say so rather than quietly averaging fewer patients.
    measuredVisits: consults.length,
    firstTokenAt: issuedTimes[0] || null,
    lastTokenAt: issuedTimes[issuedTimes.length - 1] || null,
  }
}

// A cell that opens with one of these is executed as a formula by Excel and
// Sheets when the file is opened. Patient names are typed by staff, so this is
// unlikely rather than impossible - and the fix costs one character.
const RISKY_CELL_START = /^[=+\-@\t\r]/

const escapeCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value)
  const guarded = RISKY_CELL_START.test(text) ? `'${text}` : text

  return `"${guarded.replace(/"/g, '""')}"`
}

/**
 * The day as a spreadsheet, for a clinic that wants to keep its own records.
 */
export function toCsv(tokens = []) {
  const header = [
    'Token',
    'Name',
    'Phone',
    'Status',
    'Issued',
    'Called in',
    'Completed',
    'Waited (min)',
    'With doctor (min)',
    'In clinic (min)',
  ]

  const rows = [...tokens]
    .sort((a, b) => a.token_number - b.token_number)
    .map((token) => [
      token.token_number,
      token.patient_name,
      token.patient_phone,
      statusLabel(token.status),
      formatClock(token.created_at),
      formatClock(token.called_in_at),
      formatClock(token.completed_at),
      waitedMinutes(token) ?? '',
      consultMinutes(token) ?? '',
      timeInClinicMinutes(token) ?? '',
    ])

  return [header, ...rows]
    .map((row) => row.map(escapeCell).join(','))
    .join('\n')
}

export function csvFilename(slug, date = new Date()) {
  const stamp = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)

  return `${slug}-${stamp}.csv`
}
