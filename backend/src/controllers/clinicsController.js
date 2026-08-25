const supabase = require('../config/supabase');
const { sendSms } = require('../utils/sms');

const IST_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const sendError = (res, statusCode, message) => {
  res.status(statusCode).json({
    success: false,
    error: message,
  });
};

const getIstTodayUtcRange = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);

  const startUtcMs = Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;

  return {
    start: new Date(startUtcMs).toISOString(),
    end: new Date(endUtcMs).toISOString(),
  };
};

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

const getTodayTokens = async (clinicId) => {
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

const getNextWaitingToken = async (clinicId) => {
  const { start, end } = getIstTodayUtcRange();

  const { data, error } = await supabase
    .from('tokens')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('status', 'waiting')
    .gte('created_at', start)
    .lt('created_at', end)
    .order('token_number', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
};

const getQueueContext = (tokens) => {
  const currentToken = tokens.find((token) => token.status === 'in_progress');
  const waitingCount = tokens.filter((token) => token.status === 'waiting').length;

  return {
    current_token_number: currentToken ? currentToken.token_number : null,
    waiting_count: waitingCount,
  };
};

const normalizeFrontendUrl = () => {
  const frontendUrl = process.env.FRONTEND_URL;
  return frontendUrl ? frontendUrl.replace(/\/+$/, '') : '';
};

const healthCheck = (req, res) => {
  res.json({
    success: true,
    message: 'QueueLite running',
  });
};

const createClinic = async (req, res, next) => {
  try {
    const { name, slug, doctor_name } = req.body;

    if (!name || !slug || !doctor_name) {
      return sendError(res, 400, 'name, slug, and doctor_name are required');
    }

    const { data, error } = await supabase
      .from('clinics')
      .insert({ name, slug, doctor_name })
      .select('*')
      .single();

    if (error) {
      return sendError(res, 400, error.message);
    }

    res.status(201).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

const createToken = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { patient_name, patient_phone } = req.body;
    const frontendUrl = normalizeFrontendUrl();

    if (!patient_name || !patient_phone) {
      return sendError(res, 400, 'patient_name and patient_phone are required');
    }

    if (!frontendUrl) {
      return sendError(res, 500, 'FRONTEND_URL is required');
    }

    const clinic = await getClinicBySlug(slug);

    if (!clinic) {
      return sendError(res, 404, 'Clinic not found');
    }

    const { data, error } = await supabase.rpc('create_token', {
      p_clinic_id: clinic.id,
      p_patient_name: patient_name,
      p_patient_phone: patient_phone,
    });

    if (error) {
      return sendError(res, 400, error.message);
    }

    const token = Array.isArray(data) ? data[0] : data;

    if (!token) {
      return sendError(res, 500, 'Token creation failed');
    }

    await sendSms(
      patient_phone,
      `Your token #${token.token_number} at ${clinic.name}. Track: ${frontendUrl}/q/${slug}/${token.id}`
    );

    res.status(201).json({
      success: true,
      data: token,
    });
  } catch (error) {
    next(error);
  }
};

const getTodayQueue = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const clinic = await getClinicBySlug(slug);

    if (!clinic) {
      return sendError(res, 404, 'Clinic not found');
    }

    const tokens = await getTodayTokens(clinic.id);
    const context = getQueueContext(tokens);

    res.json({
      success: true,
      data: {
        tokens,
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
    const { slug, tokenId } = req.params;
    const clinic = await getClinicBySlug(slug);

    if (!clinic) {
      return sendError(res, 404, 'Clinic not found');
    }

    const { data, error } = await supabase
      .from('tokens')
      .update({
        status: 'in_progress',
        called_in_at: new Date().toISOString(),
      })
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

    const nextWaitingToken = await getNextWaitingToken(clinic.id);

    if (nextWaitingToken) {
      await sendSms(
        nextWaitingToken.patient_phone,
        `You're next! Current token: #${data.token_number}. Head to the clinic now.`
      );
    }

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

const markNoShow = async (req, res, next) => {
  try {
    const { slug, tokenId } = req.params;
    const clinic = await getClinicBySlug(slug);

    if (!clinic) {
      return sendError(res, 404, 'Clinic not found');
    }

    const { data, error } = await supabase
      .from('tokens')
      .update({ status: 'no_show' })
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

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

const getToken = async (req, res, next) => {
  try {
    const { slug, tokenId } = req.params;
    const clinic = await getClinicBySlug(slug);

    if (!clinic) {
      return sendError(res, 404, 'Clinic not found');
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
    const patientsAhead = tokens.filter(
      (todayToken) =>
        todayToken.status === 'waiting' &&
        todayToken.token_number < token.token_number
    ).length;

    res.json({
      success: true,
      data: {
        token,
        current_token_number: context.current_token_number,
        waiting_count: context.waiting_count,
        patients_ahead: patientsAhead,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  healthCheck,
  createClinic,
  createToken,
  getTodayQueue,
  callInToken,
  markNoShow,
  getToken,
};
