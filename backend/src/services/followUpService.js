const supabase = require('../config/supabase');
const { getIstDateString, addIstDays } = require('../utils/time');

const OPEN_STATUS = 'scheduled';

/**
 * The doctor's instruction to come back, kept for the front desk.
 *
 * Stored on the visit it was given at rather than in a table of its own. The
 * patient's name and number are already on that row, so there is nothing to
 * copy and nothing that can drift out of step, and the columns inherit the
 * grants that the tokens table already has.
 *
 * Nothing here messages the patient. The clinic has no approved WhatsApp
 * template and no verified business number, so a reminder the system claimed to
 * send would never arrive. This is a list for staff to work through and contact
 * people from; automatic reminders can be layered on later without changing
 * what is stored.
 */

// What the staff list needs about a follow-up. The token row carries plenty
// more, and the shape below is what the page is written against.
const FOLLOW_UP_FIELDS =
  'id, token_number, patient_name, patient_phone, follow_up_due_on, follow_up_note, follow_up_status, created_at';

const toFollowUp = (token) => ({
  id: token.id,
  token_number: token.token_number,
  patient_name: token.patient_name,
  patient_phone: token.patient_phone,
  due_on: token.follow_up_due_on,
  note: token.follow_up_note,
  status: token.follow_up_status,
  visited_on: token.created_at,
});

const createFollowUp = async ({ token, days, note }) => {
  const { data, error } = await supabase
    .from('tokens')
    .update({
      follow_up_due_on: addIstDays(days),
      follow_up_note: note || null,
      follow_up_status: OPEN_STATUS,
    })
    .eq('id', token.id)
    .select(FOLLOW_UP_FIELDS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data && data.id ? toFollowUp(data) : null;
};

/**
 * Open follow-ups: anything already due, plus the next few weeks.
 *
 * Overdue ones are deliberately included and never expire on their own. A
 * patient who did not come back is exactly who the clinic needs in this list,
 * and dropping them once the date passed would turn a missed follow-up into no
 * follow-up at all.
 */
const listFollowUps = async (clinicId, { withinDays = 30 } = {}) => {
  const { data, error } = await supabase
    .from('tokens')
    .select(FOLLOW_UP_FIELDS)
    .eq('clinic_id', clinicId)
    .eq('follow_up_status', OPEN_STATUS)
    .lte('follow_up_due_on', addIstDays(withinDays))
    .order('follow_up_due_on', { ascending: true });

  if (error) {
    throw error;
  }

  return (data || []).map(toFollowUp);
};

const setFollowUpStatus = async (clinicId, tokenId, status) => {
  const { data, error } = await supabase
    .from('tokens')
    .update({ follow_up_status: status })
    .eq('id', tokenId)
    .eq('clinic_id', clinicId)
    // Only a token that actually carries a follow-up can have one closed.
    .not('follow_up_due_on', 'is', null)
    .select(FOLLOW_UP_FIELDS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data && data.id ? toFollowUp(data) : null;
};

// How far off a follow-up is, in clinic days, for the staff list to group and
// label by.
const daysUntil = (dueOn, today = getIstDateString()) =>
  Math.round(
    (Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000
  );

module.exports = {
  createFollowUp,
  listFollowUps,
  setFollowUpStatus,
  daysUntil,
};
