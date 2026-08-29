const supabase = require('../config/supabase');
const env = require('../config/env');
const logger = require('../utils/logger');
const { getIstDateString } = require('../utils/time');
const notifier = require('../services/notifier');
const { runRemindersInBackground } = require('../services/reminderService');
const {
  getClinicBySlug,
  getQueueState,
  invalidateQueue,
  getNextWaitingToken,
  countPatientsAhead,
  nextTokenNumber,
  supportsTokenDay,
  positionAfter,
  estimateReadyAt,
  isAfterClosing,
  toPublicToken,
} = require('../services/queueService');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sendError = (res, statusCode, message) => {
  res.status(statusCode).json({ success: false, error: message });
};

/**
 * Postgres rejects a malformed uuid with a driver-level message that we were
 * passing straight back to the caller. Check the shape here instead: it keeps
 * database internals out of responses and saves a pointless round trip.
 */
const isValidTokenId = (tokenId, res) => {
  if (!UUID_PATTERN.test(String(tokenId || ''))) {
    sendError(res, 404, 'Token not found');
    return false;
  }

  return true;
};

/**
 * This deployment serves exactly one clinic. Refusing any other slug keeps a
 * guessed URL from reaching another clinic's queue.
 */
const resolveClinic = async (req, res) => {
  const { slug } = req.params;

  if (slug !== env.clinicSlug) {
    sendError(res, 404, 'Clinic not found');
    return null;
  }

  const clinic = await getClinicBySlug(slug);

  if (!clinic) {
    sendError(res, 404, 'Clinic not found');
    return null;
  }

  return clinic;
};

// What a patient may see about the clinic: everything on its Google listing,
// nothing about anyone else in the queue.
const toPublicClinic = (clinic) => ({
  id: clinic.id,
  name: clinic.name,
  slug: clinic.slug,
  doctor_name: clinic.doctor_name,
  address: clinic.address,
  phone: clinic.phone,
  maps_url: clinic.maps_url,
  opens_at: clinic.opens_at,
  closes_at: clinic.closes_at,
});

const healthCheck = (req, res) => {
  res.json({
    success: true,
    message: 'QueueLite running',
    data: {
      clinic_slug: env.clinicSlug,
      notifier: env.notifier,
      time: new Date().toISOString(),
    },
  });
};

const getClinic = async (req, res, next) => {
  try {
    const clinic = await getClinicBySlug(env.clinicSlug);

    if (!clinic) {
      return sendError(res, 404, 'Clinic not found');
    }

    res.json({ success: true, data: toPublicClinic(clinic) });
  } catch (error) {
    next(error);
  }
};

const createToken = async (req, res, next) => {
  try {
    const { patient_name, patient_phone } = req.body || {};

    const patientName = typeof patient_name === 'string' ? patient_name.trim() : '';
    const patientPhone = typeof patient_phone === 'string' ? patient_phone.trim() : '';

    if (patientName.length < 2 || patientName.length > 80) {
      return sendError(res, 400, 'patient_name must be between 2 and 80 characters');
    }

    if (!/^\d{10}$/.test(patientPhone)) {
      return sendError(res, 400, 'patient_phone must be exactly 10 digits');
    }

    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    /**
     * Issued here rather than by a stored function.
     *
     * The function that used to do this had a stale idea of when the clinic day
     * began, so every patient after midnight was handed the previous day's last
     * number. Two attempts to replace it silently did not take on this
     * database, and a wrong token number is not a problem a patient discovers
     * later: they are holding it, and so is somebody else.
     *
     * Correctness under two entries landing together comes from the unique
     * index on (clinic, day, number), not from this read. A collision means
     * somebody else took the number in between, so read again and take the
     * next one.
     */
    const issue = async () => {
      const tokenNumber = await nextTokenNumber(clinic.id);

      return supabase
        .from('tokens')
        .insert({
          clinic_id: clinic.id,
          token_number: tokenNumber,
          patient_name: patientName,
          patient_phone: patientPhone,
          status: 'waiting',
          // Only once the column is known to exist. Sending it to a database
          // that has not had migration 006 applied would fail the insert.
          ...(supportsTokenDay() ? { token_day: getIstDateString() } : {}),
        })
        .select('*')
        .maybeSingle();
    };

    let { data: token, error } = await issue();

    // 23505 is the uniqueness constraint refusing a number already issued
    // today. Three attempts covers any realistic collision at one front desk.
    for (let attempt = 0; error?.code === '23505' && attempt < 3; attempt += 1) {
      logger.warn({ attempt: attempt + 1 }, 'token number collided, taking the next');
      ({ data: token, error } = await issue());
    }

    if (error) {
      return sendError(res, 400, error.message);
    }

    if (!token || !token.id) {
      return sendError(res, 500, 'Token creation failed');
    }

    invalidateQueue(clinic.id);
    logger.info({ tokenNumber: token.token_number }, 'token issued');

    const state = await getQueueState(clinic, { fresh: true });
    const ahead = countPatientsAhead(state.tokens, token);
    const readyAt = estimateReadyAt(ahead, state.minutes_per_patient);

    const notified = await notifier.notifyTokenIssued({
      phone: patientPhone,
      clinicName: clinic.name,
      tokenNumber: token.token_number,
      slug: clinic.slug,
      tokenId: token.id,
    });

    res.status(201).json({
      success: true,
      data: {
        ...token,
        tracking_url: notifier.trackingUrl(clinic.slug, token.id),
        patients_ahead: ahead,
        estimated_ready_at: readyAt,
        // Worth knowing at the counter, while the patient is still standing
        // there and can be told to come back tomorrow instead.
        estimate_after_closing: isAfterClosing(readyAt, clinic),
        // Only claim delivery when a real message actually went out, so the
        // desk is never told to rely on a WhatsApp the patient never got.
        notified: notified && notifier.isWhatsAppEnabled,
      },
    });

    // Someone joining an empty or nearly empty queue is immediately due their
    // reminder; nobody else's position changed.
    runRemindersInBackground(clinic);
  } catch (error) {
    next(error);
  }
};

const getTodayQueue = async (req, res, next) => {
  try {
    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const state = await getQueueState(clinic);

    res.json({
      success: true,
      data: {
        tokens: state.tokens,
        clinic: toPublicClinic(clinic),
        current_token_number: state.current_token_number,
        waiting_count: state.waiting_count,
        seen_count: state.seen_count,
        no_show_count: state.no_show_count,
        total_today: state.total_today,
        minutes_per_patient: state.minutes_per_patient,
        pace_measured: state.pace_measured,
        // The desk repeats this figure to patients, so it is told where the
        // figure came from: measured today, carried over from recent days, or
        // the clinic's configured default.
        pace_source: state.pace_source,
        reminder_lead_patients: env.reminderLeadPatients,
        // Configured is not the same as deliverable. Without an approved
        // WhatsApp template nothing goes out, and the desk should not be told
        // patients are being messaged when they are not.
        auto_reminders: notifier.canSendHeadsUp,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Moves a token to in_progress, closing out whoever was being seen. Shared by
 * Call In (a named patient) and Call Next (whoever is at the front).
 */
const callInById = async (clinic, tokenId) => {
  // Confirm the token belongs to this clinic before closing anyone out, so a
  // bad id cannot end the visit of whoever is currently being seen.
  const { data: existingToken, error: lookupError } = await supabase
    .from('tokens')
    .select('id')
    .eq('id', tokenId)
    .eq('clinic_id', clinic.id)
    .maybeSingle();

  if (lookupError) {
    return { error: { status: 400, message: lookupError.message } };
  }

  if (!existingToken) {
    return { error: { status: 404, message: 'Token not found' } };
  }

  // One statement instead of two: the previous patient is closed out and the
  // new one called in atomically, so a failure between them cannot leave the
  // clinic with nobody marked as being seen.
  const { data, error } = await supabase.rpc('call_in_token', {
    p_clinic_id: clinic.id,
    p_token_id: tokenId,
  });

  if (error) {
    return { error: { status: 400, message: error.message } };
  }

  const token = Array.isArray(data) ? data[0] : data;

  // A plpgsql function declared `returns public.tokens` that matched nothing
  // comes back as a row of every column set to null, not as null. Checking the
  // id is what actually detects that; `!token` never fires.
  if (!token || !token.id) {
    return { error: { status: 404, message: 'Token not found' } };
  }

  invalidateQueue(clinic.id);
  logger.info({ tokenNumber: token.token_number }, 'token called in');

  return { token };
};

const callInToken = async (req, res, next) => {
  try {
    const { tokenId } = req.params;

    if (!isValidTokenId(tokenId, res)) {
      return undefined;
    }

    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const { token, error } = await callInById(clinic, tokenId);

    if (error) {
      return sendError(res, error.status, error.message);
    }

    res.json({ success: true, data: token });

    // Everyone behind just moved up one, which is what decides who is now due
    // a reminder - so this runs after every call-in, not only the first.
    runRemindersInBackground(clinic);
  } catch (error) {
    next(error);
  }
};

/**
 * Calls in whoever is at the front of the queue.
 *
 * With a hundred tokens on the screen, hunting for the right row is the slowest
 * thing the front desk does, and calling in the wrong one is a real mis-tap.
 * The queue already knows who is next.
 */
const callNext = async (req, res, next) => {
  try {
    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const frontOfQueue = await getNextWaitingToken(clinic.id);

    if (!frontOfQueue) {
      return sendError(res, 409, 'Nobody is waiting');
    }

    const { token, error } = await callInById(clinic, frontOfQueue.id);

    if (error) {
      return sendError(res, error.status, error.message);
    }

    res.json({ success: true, data: token });

    runRemindersInBackground(clinic);
  } catch (error) {
    next(error);
  }
};

/**
 * Puts a patient back in the queue, a chosen number of patients later.
 *
 * This is the answer to the two things the desk could not do before. A patient
 * who misses their call had to be marked no-show and dropped, and a no-show who
 * turned up twenty minutes later could only be restored to the *front*, because
 * their token number was the lowest one still waiting - ahead of everybody who
 * had been sitting there the whole time.
 *
 * Works from any status, because "see this person after three more patients" is
 * a sensible instruction whether they are waiting, mid-call, or were written
 * off half an hour ago.
 */
const pushBackToken = async (req, res, next) => {
  try {
    const { tokenId } = req.params;

    if (!isValidTokenId(tokenId, res)) {
      return undefined;
    }

    const places = Number(req.body?.places);

    if (!Number.isInteger(places) || places < 1 || places > 50) {
      return sendError(res, 400, 'places must be a whole number between 1 and 50');
    }

    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const state = await getQueueState(clinic, { fresh: true });
    const token = state.tokens.find((candidate) => candidate.id === tokenId);

    if (!token) {
      return sendError(res, 404, 'Token not found');
    }

    const { data, error } = await supabase
      .from('tokens')
      .update({
        queue_position: positionAfter(state.tokens, token, places),
        status: 'waiting',
        // They were not actually seen, so this must not count towards the
        // measured consultation pace.
        called_in_at: null,
        completed_at: null,
        // Their position has changed, so whatever they were told about it no
        // longer holds - let them be reminded again at the new spot.
        heads_up_sent_at: null,
        turn_notified_at: null,
      })
      .eq('id', tokenId)
      .eq('clinic_id', clinic.id)
      .select('*')
      .maybeSingle();

    if (error) {
      return sendError(res, 400, error.message);
    }

    if (!data || !data.id) {
      return sendError(res, 404, 'Token not found');
    }

    invalidateQueue(clinic.id);
    logger.info(
      { tokenNumber: data.token_number, places },
      'token pushed back in the queue'
    );

    res.json({ success: true, data });

    runRemindersInBackground(clinic);
  } catch (error) {
    next(error);
  }
};

const setTokenStatus = (status, logMessage) => async (req, res, next) => {
  try {
    const { tokenId } = req.params;

    if (!isValidTokenId(tokenId, res)) {
      return undefined;
    }

    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const patch = { status };

    // The only honest record of when a visit ended. Without it a consultation's
    // length can only be inferred from when the next patient was called, which
    // is a different measurement.
    if (status === 'done') {
      patch.completed_at = new Date().toISOString();
    }

    // Back in the queue means back to being un-notified: their position is
    // about to change, and the reminders they already got no longer describe
    // where they now stand.
    if (status === 'waiting') {
      patch.heads_up_sent_at = null;
      patch.turn_notified_at = null;
      patch.called_in_at = null;
      patch.completed_at = null;
    }

    const { data, error } = await supabase
      .from('tokens')
      .update(patch)
      .eq('id', tokenId)
      .eq('clinic_id', clinic.id)
      .select('*')
      .maybeSingle();

    if (error) {
      return sendError(res, 400, error.message);
    }

    if (!data) {
      return sendError(res, 404, 'Token not found');
    }

    invalidateQueue(clinic.id);
    logger.info({ tokenNumber: data.token_number }, logMessage);

    res.json({ success: true, data });

    // Finishing a visit or dropping a no-show pulls everyone behind forward,
    // so the reminder pass has to run here too.
    runRemindersInBackground(clinic);
  } catch (error) {
    next(error);
  }
};

const completeToken = setTokenStatus('done', 'token completed');
const markNoShow = setTokenStatus('no_show', 'token marked no-show');
// Call In and No Show sit next to each other on a phone, so a mis-tap is easy
// and was previously unrecoverable - the patient just vanished from the queue.
const restoreToken = setTokenStatus('waiting', 'token returned to the queue');

/**
 * The waiting-room board: what is on the screen at the desk, and what a patient
 * who was given only a token number over the phone can look up themselves.
 *
 * Public and unauthenticated, so it carries no names and no phone numbers -
 * only numbers and counts. A token number is guessable (they run 1, 2, 3...),
 * which is exactly why nothing here identifies the person holding one.
 */
const getBoard = async (req, res, next) => {
  try {
    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const state = await getQueueState(clinic);

    const board = {
      clinic: toPublicClinic(clinic),
      current_token_number: state.current_token_number,
      waiting_count: state.waiting_count,
      seen_count: state.seen_count,
      minutes_per_patient: state.minutes_per_patient,
      pace_measured: state.pace_measured,
      // The last few called, so someone glancing up can tell the queue is
      // moving rather than stuck.
      recently_called: state.tokens
        .filter((token) => token.called_in_at)
        .sort((a, b) => new Date(b.called_in_at) - new Date(a.called_in_at))
        .slice(0, 5)
        .map((token) => token.token_number),
    };

    // Optional lookup: "I was told I am number 47."
    const requested = Number(req.query.token);

    if (Number.isInteger(requested) && requested > 0) {
      const token = state.tokens.find(
        (candidate) => candidate.token_number === requested
      );

      if (!token) {
        board.lookup = { token_number: requested, found: false };
      } else {
        const ahead = countPatientsAhead(state.tokens, token);
        const readyAt =
          token.status === 'waiting'
            ? estimateReadyAt(ahead, state.minutes_per_patient)
            : null;

        board.lookup = {
          token_number: token.token_number,
          found: true,
          status: token.status,
          patients_ahead: ahead,
          estimated_ready_at: readyAt,
          estimate_after_closing: isAfterClosing(readyAt, clinic),
        };
      }
    }

    res.json({ success: true, data: board });
  } catch (error) {
    next(error);
  }
};

// Public: reachable by anyone holding the tracking link, so it must not leak
// the patient's phone number.
const getToken = async (req, res, next) => {
  try {
    const { tokenId } = req.params;

    if (!isValidTokenId(tokenId, res)) {
      return undefined;
    }

    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const state = await getQueueState(clinic);

    // The token is already in the snapshot the whole waiting room shares, so
    // reading it from there costs nothing. Only a link to some other day's
    // token needs its own lookup.
    let token = state.tokens.find((candidate) => candidate.id === tokenId);

    if (!token) {
      const { data, error } = await supabase
        .from('tokens')
        .select('*')
        .eq('id', tokenId)
        .eq('clinic_id', clinic.id)
        .maybeSingle();

      if (error) {
        return sendError(res, 400, error.message);
      }

      token = data;
    }

    if (!token) {
      return sendError(res, 404, 'Token not found');
    }

    const ahead = countPatientsAhead(state.tokens, token);
    const isWaiting = token.status === 'waiting';
    const readyAt = isWaiting
      ? estimateReadyAt(ahead, state.minutes_per_patient)
      : null;

    res.json({
      success: true,
      data: {
        token: toPublicToken(token),
        clinic: toPublicClinic(clinic),
        current_token_number: state.current_token_number,
        waiting_count: state.waiting_count,
        patients_ahead: ahead,
        minutes_per_patient: state.minutes_per_patient,
        pace_measured: state.pace_measured,
        estimated_ready_at: readyAt,
        estimate_after_closing: isAfterClosing(readyAt, clinic),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  healthCheck,
  getClinic,
  getBoard,
  createToken,
  getTodayQueue,
  callInToken,
  callNext,
  pushBackToken,
  completeToken,
  markNoShow,
  restoreToken,
  getToken,
};
