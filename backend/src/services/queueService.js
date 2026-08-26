const supabase = require('../config/supabase');
const { getIstTodayUtcRange } = require('../utils/time');

const ACTIVE_STATUSES = ['waiting', 'in_progress'];

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

  const { start, end } = getIstTodayUtcRange();

  const { data, error } = await supabase
    .from('tokens')
    .select('*')
    .eq('clinic_id', clinicId)
    .like('patient_phone', `%${last10}`)
    .in('status', ACTIVE_STATUSES)
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

const closeOutInProgress = async (clinicId, exceptTokenId) => {
  const { start, end } = getIstTodayUtcRange();

  let query = supabase
    .from('tokens')
    .update({ status: 'done' })
    .eq('clinic_id', clinicId)
    .eq('status', 'in_progress')
    .gte('created_at', start)
    .lt('created_at', end);

  if (exceptTokenId) {
    query = query.neq('id', exceptTokenId);
  }

  const { error } = await query;

  if (error) {
    throw error;
  }
};

const getQueueContext = (tokens) => {
  const currentToken = tokens.find((token) => token.status === 'in_progress');

  return {
    current_token_number: currentToken ? currentToken.token_number : null,
    waiting_count: tokens.filter((token) => token.status === 'waiting').length,
  };
};

const countPatientsAhead = (tokens, token) =>
  tokens.filter(
    (other) => other.status === 'waiting' && other.token_number < token.token_number
  ).length;

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
  getNextWaitingToken,
  findActiveTokenByPhone,
  closeOutInProgress,
  getQueueContext,
  countPatientsAhead,
  toPublicToken,
};
