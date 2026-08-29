/**
 * Dates and times, formatted for the clinic.
 *
 * One module rather than a copy in each page, and every entry point guards its
 * input. Intl throws a RangeError on an invalid date, and with no error
 * boundary that used to take the whole screen down: one malformed value from
 * the API and the front desk is looking at a blank page mid-clinic.
 */

const IST = 'Asia/Kolkata'

const isValid = (date) => date instanceof Date && !Number.isNaN(date.getTime())

/** A wall-clock time at the clinic: "3:40 pm". Empty string for anything unusable. */
export function formatClock(instant) {
  if (!instant) {
    return ''
  }

  const date = new Date(instant)

  if (!isValid(date)) {
    return ''
  }

  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(date)
    .toLowerCase()
}

/**
 * A calendar day as "Sat, 13 Sep", from a plain yyyy-mm-dd.
 *
 * Read at midday so the label cannot slip a day either side of midnight
 * whichever timezone the browser happens to be in.
 */
export function formatDayDate(day, { weekday = 'short', month = 'short' } = {}) {
  if (!day) {
    return ''
  }

  const date = new Date(`${day}T06:00:00Z`)

  if (!isValid(date)) {
    return ''
  }

  return new Intl.DateTimeFormat('en-IN', {
    weekday,
    day: 'numeric',
    month,
    timeZone: IST,
  }).format(date)
}

/** Today at the clinic, spelled out for a page heading. */
export function formatToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: IST,
  }).format(now)
}
