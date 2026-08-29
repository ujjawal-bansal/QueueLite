const IST_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The queue day is an Asia/Kolkata calendar day, not a UTC one: token numbers
 * restart at IST midnight regardless of where the server runs. Returns the UTC
 * instants bounding "today" so they can be compared against created_at.
 */
const getIstTodayUtcRange = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const startUtcMs =
    Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) -
    IST_OFFSET_MS;

  return {
    start: new Date(startUtcMs).toISOString(),
    end: new Date(startUtcMs + 24 * 60 * 60 * 1000).toISOString(),
  };
};

/**
 * The UTC instant of a given wall-clock time on the current Kolkata day.
 *
 * Postgres hands back a `time` as "18:00:00" with no date. Turning that into a
 * comparable instant is how the app knows whether an estimate has run past the
 * clinic's closing time.
 */
const getIstInstantToday = (localTime, now = new Date()) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(localTime || ''));

  if (!match) {
    return null;
  }

  const { start } = getIstTodayUtcRange(now);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  return new Date(Date.parse(start) + (hours * 60 + minutes) * 60000);
};

/**
 * A wall-clock time at the clinic, e.g. "3:40 pm".
 *
 * The server runs in UTC, so anything shown to a patient or written into a
 * WhatsApp message has to be rendered in Kolkata time explicitly.
 */
const formatIstClock = (instant) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(instant))
    .toLowerCase();

/**
 * Today's date at the clinic, as "2026-08-29".
 *
 * Follow-ups are stored as dates rather than instants, so every comparison
 * against them has to be made in the clinic's own day, not the server's.
 */
const getIstDateString = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

/** The clinic date `days` from today, as "2026-09-13". */
const addIstDays = (days, now = new Date()) => {
  const [year, month, day] = getIstDateString(now).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  return shifted.toISOString().slice(0, 10);
};

module.exports = {
  getIstTodayUtcRange,
  getIstDateString,
  addIstDays,
  getIstInstantToday,
  formatIstClock,
  IST_TIME_ZONE,
  IST_OFFSET_MS,
};
