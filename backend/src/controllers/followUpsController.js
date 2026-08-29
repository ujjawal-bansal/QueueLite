const env = require('../config/env');
const logger = require('../utils/logger');
const {
  createFollowUp,
  listFollowUps,
  setFollowUpStatus,
  daysUntil,
} = require('../services/followUpService');
const { getClinicBySlug, getTodayTokens } = require('../services/queueService');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sendError = (res, statusCode, message) => {
  res.status(statusCode).json({ success: false, error: message });
};

const resolveClinic = async (req, res) => {
  if (req.params.slug !== env.clinicSlug) {
    sendError(res, 404, 'Clinic not found');
    return null;
  }

  const clinic = await getClinicBySlug(env.clinicSlug);

  if (!clinic) {
    sendError(res, 404, 'Clinic not found');
    return null;
  }

  return clinic;
};

// A year is already well past any ophthalmology review interval, and a typo
// that schedules somebody for 2031 is worse than one that is refused.
const MAX_FOLLOW_UP_DAYS = 365;
const MAX_NOTE_LENGTH = 500;

/**
 * Records "come back in X days" against a visit.
 *
 * Created from the token rather than from free-typed patient details, so the
 * name and number on the follow-up are the ones the desk already checked when
 * the token was issued.
 */
const addFollowUp = async (req, res, next) => {
  try {
    const { tokenId } = req.params;

    if (!UUID_PATTERN.test(String(tokenId || ''))) {
      return sendError(res, 404, 'Token not found');
    }

    const days = Number(req.body?.days);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';

    if (!Number.isInteger(days) || days < 1 || days > MAX_FOLLOW_UP_DAYS) {
      return sendError(
        res,
        400,
        `days must be a whole number between 1 and ${MAX_FOLLOW_UP_DAYS}`
      );
    }

    if (note.length > MAX_NOTE_LENGTH) {
      return sendError(res, 400, `note must be ${MAX_NOTE_LENGTH} characters or fewer`);
    }

    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const tokens = await getTodayTokens(clinic.id);
    const token = tokens.find((candidate) => candidate.id === tokenId);

    if (!token) {
      return sendError(res, 404, 'Token not found');
    }

    const followUp = await createFollowUp({ token, days, note });

    if (!followUp) {
      return sendError(res, 404, 'Token not found');
    }

    logger.info({ tokenNumber: token.token_number, days }, 'follow-up scheduled');

    res.status(201).json({ success: true, data: followUp });
  } catch (error) {
    next(error);
  }
};

const getFollowUps = async (req, res, next) => {
  try {
    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const followUps = await listFollowUps(clinic.id);

    res.json({
      success: true,
      data: {
        follow_ups: followUps.map((followUp) => ({
          ...followUp,
          days_until: daysUntil(followUp.due_on),
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

const updateFollowUp = (status, logMessage) => async (req, res, next) => {
  try {
    const { followUpId } = req.params;

    if (!UUID_PATTERN.test(String(followUpId || ''))) {
      return sendError(res, 404, 'Follow-up not found');
    }

    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const followUp = await setFollowUpStatus(clinic.id, followUpId, status);

    if (!followUp) {
      return sendError(res, 404, 'Follow-up not found');
    }

    logger.info({ status }, logMessage);

    res.json({ success: true, data: followUp });
  } catch (error) {
    next(error);
  }
};

const completeFollowUp = updateFollowUp('completed', 'follow-up completed');
const cancelFollowUp = updateFollowUp('cancelled', 'follow-up cancelled');

module.exports = {
  addFollowUp,
  getFollowUps,
  completeFollowUp,
  cancelFollowUp,
};
