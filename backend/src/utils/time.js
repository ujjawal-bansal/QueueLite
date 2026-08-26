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

module.exports = { getIstTodayUtcRange, IST_TIME_ZONE, IST_OFFSET_MS };
