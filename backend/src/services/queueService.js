const supabase = require('../config/supabase');
const env = require('../config/env');
const logger = require('../utils/logger');
const { getIstTodayUtcRange, getIstInstantToday } = require('../utils/time');

const ACTIVE_STATUSES = ['waiting', 'in_progress'];

// A full waiting room polls its tracking pages roughly 700 times a minute, and
// every one of those reads needs the same answer: today's tokens. Serving them
// from one short-lived snapshot turns that into ~24 database reads a minute.
// Two and a half seconds is under the poll interval, so nobody sees a stale
// queue for longer than one refresh.
const SNAPSHOT_TTL_MS = 2500;

const getClinicBySlug = async (slug) => {
  const { data, error } = await supabase
    .from('clinics')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
};

const fetchTodayTokens = async (clinicId) => {
  const { start, end } = getIstTodayUtcRange();

  const { data, error } = await supabase
    .from('tokens')
    .select('*')
    .eq('clinic_id', clinicId)
    .gte('created_at', start)
    .lt('created_at', end)
    .order('token_number', { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
};

// One entry per clinic; this deployment serves exactly one, so the map never
// grows. Holding the in-flight promise is what makes concurrent callers share a
// single query instead of each starting their own.
const snapshots = new Map();

const invalidateQueue = (clinicId) => {
  snapshots.delete(clinicId);
};

/**
 * Today's tokens, shared across every concurrent reader for a moment. Staff
 * mutations call invalidateQueue, so the desk never reads its own stale write.
 */
const getTodayTokens = async (clinicId, { fresh = false } = {}) => {
  const cached = snapshots.get(clinicId);

  if (!fresh && cached) {
    // Still warm, or still loading: either way this caller joins it.
    if (cached.pending || Date.now() - cached.fetchedAt < SNAPSHOT_TTL_MS) {
      return cached.promise;
    }
  }

  const entry = { pending: true, fetchedAt: Date.now(), promise: null };

  entry.promise = fetchTodayTokens(clinicId)
    .then((tokens) => {
      entry.pending = false;
      entry.fetchedAt = Date.now();
      return tokens;
    })
    .catch((error) => {
      // A failed read must not be cached, or one blip freezes the queue for
      // everyone until the TTL expires.
      snapshots.delete(clinicId);
      throw error;
    });

  snapshots.set(clinicId, entry);

  return entry.promise;
};

/**
 * Whoever is at the front of the queue right now.
 *
 * Reads past the snapshot deliberately. Everything else can tolerate a
 * two-second-old view of the queue, but this decides which patient gets called
 * in - and acting on a stale front means calling in someone another device
 * already saw, silently skipping a real patient.
 */
/**
 * Where a token sits in today's queue.
 *
 * Almost always its own number: queue_position is set only for a patient who
 * has been pushed back, so an ordinary day never touches it.
 */
const effectivePosition = (token) => {
  const deferred = token?.queue_position;

  return deferred === null || deferred === undefined
    ? Number(token?.token_number)
    : Number(deferred);
};

/**
 * Queue order. Token number breaks ties, so two patients deferred to the same
 * spot keep a stable, explainable order rather than swapping about between
 * polls.
 */
const compareQueueOrder = (a, b) =>
  effectivePosition(a) - effectivePosition(b) || a.token_number - b.token_number;

const waitingInOrder = (tokens) =>
  tokens.filter((token) => token.status === 'waiting').sort(compareQueueOrder);

/**
 * Where to place a patient so that `places` *more* patients are seen first.
 *
 * Counted from where the patient stands now, not from the front of the queue.
 * Absolute placement reads fine for the case it was written for - someone at
 * the front who did not answer - but applied to a patient already five back it
 * would move them forwards, which is the opposite of what "push back" says on
 * the button.
 *
 * Someone not currently waiting - a no-show returning late, or the patient
 * being seen - has nobody ahead of them to count from, so `places` is measured
 * from the front for them.
 *
 * Returns a position strictly between the patient they should follow and the
 * one after that. Because positions are numeric that midpoint always exists, so
 * a patient can be pushed back repeatedly without renumbering the queue.
 */
const positionAfter = (tokens, token, places) => {
  const others = waitingInOrder(tokens).filter(
    (candidate) => candidate.id !== token.id
  );

  const alreadyAhead =
    token.status === 'waiting' ? countPatientsAhead(tokens, token) : 0;

  // Fewer patients waiting than we were asked to skip: put them at the back.
  const anchorIndex = Math.min(alreadyAhead + places, others.length) - 1;

  if (anchorIndex < 0) {
    return effectivePosition(token);
  }

  const anchor = effectivePosition(others[anchorIndex]);
  const follower = others[anchorIndex + 1];

  if (!follower) {
    // Last in the queue: a whole step past the back is plenty of room.
    return anchor + 1;
  }

  return (anchor + effectivePosition(follower)) / 2;
};

const getNextWaitingToken = async (clinicId) => {
  const tokens = await getTodayTokens(clinicId, { fresh: true });

  return waitingInOrder(tokens)[0] || null;
};

/**
 * Finds a patient's live token for today by phone number, so an inbound
 * WhatsApp message can be answered without the patient quoting an id. Matches
 * on the last 10 digits, since WhatsApp delivers numbers in E.164.
 */
const findActiveTokenByPhone = async (clinicId, phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  const last10 = digits.slice(-10);

  if (last10.length !== 10) {
    return null;
  }

  const tokens = await getTodayTokens(clinicId);

  return (
    tokens.find(
      (token) =>
        ACTIVE_STATUSES.includes(token.status) &&
        String(token.patient_phone || '').replace(/\D/g, '').endsWith(last10)
    ) || null
  );
};

const getQueueContext = (tokens) => {
  const currentToken = tokens.find((token) => token.status === 'in_progress');

  return {
    current_token_number: currentToken ? currentToken.token_number : null,
    waiting_count: tokens.filter((token) => token.status === 'waiting').length,
  };
};

// Ahead in the queue, which since deferrals exist is no longer the same as
// "holding a lower token number".
const countPatientsAhead = (tokens, token) =>
  tokens.filter(
    (other) =>
      other.status === 'waiting' &&
      other.id !== token.id &&
      compareQueueOrder(other, token) < 0
  ).length;

// A gap this long is a lunch break or the doctor stepping into surgery, not a
// consultation. Averaging it in would tell everyone still waiting that the
// queue moves at 40 minutes a patient.
const MAX_CREDIBLE_GAP_MINUTES = 40;
const MIN_CREDIBLE_GAP_MINUTES = 0.5;
// Enough samples to be stable, few enough to track how the clinic is running
// right now rather than how it ran three hours ago.
const PACE_SAMPLE_SIZE = 12;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

/**
 * How many minutes a patient actually takes today, measured from the gaps
 * between consecutive call-ins.
 *
 * A fixed five minutes is fine for a ten-patient morning and badly wrong for a
 * hundred: it is the difference between telling patient #90 "in about 2 hours"
 * and telling them the truth. The median resists the one long consult that
 * would otherwise drag every estimate up.
 */
/**
 * The gaps between consecutive call-ins in one day, in minutes.
 *
 * This, not the length of a consultation, is what predicts a wait: it already
 * contains the turnaround between patients, the time the doctor spends writing
 * notes, and the patient who takes a minute to walk in from the corridor.
 */
const callInGaps = (tokens) => {
  const calledInAt = tokens
    .filter((token) => token.called_in_at)
    .map((token) => new Date(token.called_in_at).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);

  const gaps = [];

  for (let index = 1; index < calledInAt.length; index += 1) {
    const minutes = (calledInAt[index] - calledInAt[index - 1]) / 60000;

    if (minutes >= MIN_CREDIBLE_GAP_MINUTES && minutes <= MAX_CREDIBLE_GAP_MINUTES) {
      gaps.push(minutes);
    }
  }

  return gaps;
};

/**
 * How many minutes a patient takes, and where that number came from.
 *
 * Three sources, in descending order of how much they know about today:
 *
 *   today    - the median of the last dozen call-in gaps, once there are enough
 *   history  - the same measure over recent days, for the morning before there
 *              are; without it the first twenty patients of every day are quoted
 *              a number nobody measured
 *   default  - the clinic's own figure, for a clinic with no history at all
 *
 * The median rather than the mean throughout, so one long consultation does not
 * drag every waiting patient's estimate up with it.
 */
const getMinutesPerPatient = (tokens, clinic, history = null) => {
  const configured = Number(clinic?.avg_consult_minutes) || env.avgConsultMinutes;

  // The clinic's own figure is the answer unless measuring is switched on.
  if (!env.useMeasuredPace) {
    return {
      minutesPerPatient: configured,
      measured: false,
      source: 'clinic',
      samples: 0,
    };
  }

  const gaps = callInGaps(tokens);

  // Three samples is the point where the median stops being one arbitrary
  // consultation and starts describing the day.
  if (gaps.length >= 3) {
    const recent = gaps.slice(-PACE_SAMPLE_SIZE);

    return {
      minutesPerPatient: Math.round(median(recent) * 10) / 10,
      measured: true,
      source: 'today',
      samples: recent.length,
    };
  }

  if (history?.minutesPerPatient) {
    return {
      minutesPerPatient: history.minutesPerPatient,
      measured: true,
      source: 'history',
      samples: history.samples,
    };
  }

  return {
    minutesPerPatient: configured,
    measured: false,
    source: 'default',
    samples: gaps.length,
  };
};

/**
 * When a patient with `ahead` people in front of them is likely to be called,
 * as a UTC instant. The patient page turns this into a clock time, which is far
 * easier to act on than "roughly 340 minutes".
 */
const estimateReadyAt = (ahead, minutesPerPatient, now = Date.now()) => {
  if (!Number.isFinite(ahead) || ahead < 0) {
    return null;
  }

  return new Date(now + ahead * minutesPerPatient * 60000).toISOString();
};

// Every clinic runs a little past its posted hours, and the last few patients
// of the day are always seen. Warning someone whose estimate is nine minutes
// over would frighten them out of a visit that will happen fine.
const CLOSING_GRACE_MS = 30 * 60 * 1000;

/**
 * Whether an estimate has run well past the clinic's closing time.
 *
 * At six minutes a patient an eight-hour day holds about eighty people, so on a
 * hundred-patient morning the tail of the queue genuinely does not fit. Telling
 * patient #95 "around 1:35 am" is worse than telling them nothing: it is
 * obviously wrong, and it hides the thing they need to know, which is that
 * today's queue is longer than today.
 */
const isAfterClosing = (instant, clinic, now = new Date()) => {
  const closing = getIstInstantToday(clinic?.closes_at, now);

  if (!closing || !instant) {
    return false;
  }

  return new Date(instant).getTime() > closing.getTime() + CLOSING_GRACE_MS;
};

// How many past days to learn from, and how long the answer stays good for.
// A clinic's pace changes over weeks, not minutes, so reading this on every
// poll would be a week of tokens fetched hundreds of times an hour to produce
// the same number.
const HISTORY_DAYS = 7;
const HISTORY_TTL_MS = 60 * 60 * 1000;

const paceHistory = new Map();

const fetchHistoricalPace = async (clinicId) => {
  const { start } = getIstTodayUtcRange();
  const from = new Date(Date.parse(start) - HISTORY_DAYS * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('tokens')
    .select('called_in_at')
    .eq('clinic_id', clinicId)
    .not('called_in_at', 'is', null)
    .gte('created_at', from.toISOString())
    .lt('created_at', start)
    .order('called_in_at', { ascending: true });

  if (error) {
    // A wait estimate is not worth failing a request over; the caller falls
    // back to the clinic's configured figure.
    logger.error({ err: { message: error.message } }, 'pace history read failed');
    return null;
  }

  const tokens = data || [];

  // Gaps must be computed within a day, never across the overnight break -
  // otherwise every night counts as one enormous consultation.
  const byDay = new Map();

  tokens.forEach((token) => {
    const day = new Date(token.called_in_at).toISOString().slice(0, 10);

    if (!byDay.has(day)) {
      byDay.set(day, []);
    }

    byDay.get(day).push(token);
  });

  const gaps = [...byDay.values()].flatMap((dayTokens) => callInGaps(dayTokens));

  if (gaps.length < 10) {
    return null;
  }

  return {
    minutesPerPatient: Math.round(median(gaps) * 10) / 10,
    samples: gaps.length,
    days: byDay.size,
  };
};

/**
 * What this clinic's pace has looked like recently.
 *
 * Exists for the first hour of the day. Before it, every patient issued a token
 * before the third call-in was quoted the clinic's configured guess, which on a
 * busy morning is the difference between "around 11:20" and a number nobody
 * measured.
 */
const getHistoricalPace = async (clinicId) => {
  const cached = paceHistory.get(clinicId);

  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS) {
    return cached.value;
  }

  const value = await fetchHistoricalPace(clinicId);

  paceHistory.set(clinicId, { value, fetchedAt: Date.now() });

  return value;
};

/**
 * The queue as everything else needs it: the day's tokens plus the derived
 * figures, computed once instead of in each caller.
 */
const getQueueState = async (clinic, { fresh = false } = {}) => {
  const tokens = await getTodayTokens(clinic.id, { fresh });
  const context = getQueueContext(tokens);

  // Only worth reading history while measuring is on and today cannot answer
  // for itself, which is the first few patients of the morning.
  const needsHistory = env.useMeasuredPace && callInGaps(tokens).length < 3;
  const history = needsHistory ? await getHistoricalPace(clinic.id) : null;
  const pace = getMinutesPerPatient(tokens, clinic, history);

  return {
    tokens,
    ...context,
    minutes_per_patient: pace.minutesPerPatient,
    pace_measured: pace.measured,
    pace_source: pace.source,
    pace_samples: pace.samples,
    total_today: tokens.length,
    seen_count: tokens.filter((token) => token.status === 'done').length,
    no_show_count: tokens.filter((token) => token.status === 'no_show').length,
  };
};

/**
 * Claims a reminder for a token, returning true only for the caller that won.
 *
 * The claim is a conditional update in Postgres, so a retried request or a
 * second instance mid-redeploy cannot both decide to send. Losing the claim is
 * the normal case, not an error.
 */
const claimReminder = async (tokenId, kind) => {
  const { data, error } = await supabase.rpc('claim_reminder', {
    p_token_id: tokenId,
    p_kind: kind,
  });

  if (error) {
    // Never let reminder bookkeeping break a staff action. Refusing the claim
    // on error means a patient may miss one message; throwing would mean the
    // front desk sees their tap fail.
    logger.error({ err: { message: error.message }, kind }, 'reminder claim failed');
    return false;
  }

  return data === true;
};

/**
 * Hands a claimed reminder back, so a later pass can try it again.
 *
 * Used only when the send definitely did not happen. Nothing else clears these
 * columns, so a reminder can never be silently un-sent.
 */
const releaseReminder = async (tokenId, kind) => {
  const column = kind === 'heads_up' ? 'heads_up_sent_at' : 'turn_notified_at';

  const { error } = await supabase
    .from('tokens')
    .update({ [column]: null })
    .eq('id', tokenId);

  if (error) {
    logger.error({ err: { message: error.message }, kind }, 'reminder release failed');
  }
};

// Patient-facing shape: never expose the phone number to whoever holds the link.
const toPublicToken = (token) => ({
  id: token.id,
  token_number: token.token_number,
  patient_name: token.patient_name,
  status: token.status,
  created_at: token.created_at,
  called_in_at: token.called_in_at,
});

module.exports = {
  getClinicBySlug,
  getTodayTokens,
  getQueueState,
  invalidateQueue,
  getNextWaitingToken,
  findActiveTokenByPhone,
  getQueueContext,
  countPatientsAhead,
  effectivePosition,
  compareQueueOrder,
  waitingInOrder,
  positionAfter,
  getMinutesPerPatient,
  callInGaps,
  estimateReadyAt,
  isAfterClosing,
  claimReminder,
  releaseReminder,
  toPublicToken,
};
