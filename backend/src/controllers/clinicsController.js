const supabase = require('../config/supabase');
const env = require('../config/env');
const logger = require('../utils/logger');
const notifier = require('../services/notifier');
const {
  getClinicBySlug,
  getTodayTokens,
  getNextWaitingToken,
  closeOutInProgress,
  getQueueContext,
  countPatientsAhead,
  toPublicToken,
} = require('../services/queueService');

const sendError = (res, statusCode, message) => {
  res.status(statusCode).json({ success: false, error: message });
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

    res.json({
      success: true,
      data: {
        id: clinic.id,
        name: clinic.name,
        slug: clinic.slug,
        doctor_name: clinic.doctor_name,
      },
    });
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

    const { data, error } = await supabase.rpc('create_token', {
      p_clinic_id: clinic.id,
      p_patient_name: patientName,
      p_patient_phone: patientPhone,
    });

    if (error) {
      return sendError(res, 400, error.message);
    }

    const token = Array.isArray(data) ? data[0] : data;

    if (!token) {
      return sendError(res, 500, 'Token creation failed');
    }

    logger.info({ tokenNumber: token.token_number }, 'token issued');

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
        // Only claim delivery when a real message actually went out, so the
        // desk is never told to rely on a WhatsApp the patient never got.
        notified: notified && notifier.isWhatsAppEnabled,
      },
    });
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

    const tokens = await getTodayTokens(clinic.id);
    const context = getQueueContext(tokens);

    res.json({
      success: true,
      data: {
        tokens,
        clinic: {
          id: clinic.id,
          name: clinic.name,
          slug: clinic.slug,
          doctor_name: clinic.doctor_name,
        },
        current_token_number: context.current_token_number,
        waiting_count: context.waiting_count,
      },
    });
  } catch (error) {
    next(error);
  }
};

const callInToken = async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    // Confirm the token belongs to this clinic before closing anyone out, so a
    // bad id cannot end the visit of whoever is currently being seen.
    const { data: existingToken, error: lookupError } = await supabase
      .from('tokens')
      .select('id')
      .eq('id', tokenId)
      .eq('clinic_id', clinic.id)
      .maybeSingle();

    if (lookupError) {
      return sendError(res, 400, lookupError.message);
    }

    if (!existingToken) {
      return sendError(res, 404, 'Token not found');
    }

    await closeOutInProgress(clinic.id, tokenId);

    const { data, error } = await supabase
      .from('tokens')
      .update({ status: 'in_progress', called_in_at: new Date().toISOString() })
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

    logger.info({ tokenNumber: data.token_number }, 'token called in');

    const nextWaitingToken = await getNextWaitingToken(clinic.id);

    if (nextWaitingToken) {
      await notifier.notifyYourTurn({
        phone: nextWaitingToken.patient_phone,
        clinicName: clinic.name,
        tokenNumber: nextWaitingToken.token_number,
        currentTokenNumber: data.token_number,
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

const setTokenStatus = (status, logMessage) => async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const { data, error } = await supabase
      .from('tokens')
      .update({ status })
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

    logger.info({ tokenNumber: data.token_number }, logMessage);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

const completeToken = setTokenStatus('done', 'token completed');
const markNoShow = setTokenStatus('no_show', 'token marked no-show');

// Public: reachable by anyone holding the tracking link, so it must not leak
// the patient's phone number.
const getToken = async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    const clinic = await resolveClinic(req, res);

    if (!clinic) {
      return undefined;
    }

    const { data: token, error } = await supabase
      .from('tokens')
      .select('*')
      .eq('id', tokenId)
      .eq('clinic_id', clinic.id)
      .maybeSingle();

    if (error) {
      return sendError(res, 400, error.message);
    }

    if (!token) {
      return sendError(res, 404, 'Token not found');
    }

    const tokens = await getTodayTokens(clinic.id);
    const context = getQueueContext(tokens);

    res.json({
      success: true,
      data: {
        token: toPublicToken(token),
        clinic: {
          name: clinic.name,
          slug: clinic.slug,
          doctor_name: clinic.doctor_name,
        },
        current_token_number: context.current_token_number,
        waiting_count: context.waiting_count,
        patients_ahead: countPatientsAhead(tokens, token),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  healthCheck,
  getClinic,
  createToken,
  getTodayQueue,
  callInToken,
  completeToken,
  markNoShow,
  getToken,
};
