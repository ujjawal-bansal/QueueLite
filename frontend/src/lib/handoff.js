/**
 * Handing a patient their tracking link from the desk's own phone.
 *
 * The WhatsApp Cloud API can only message numbers registered in Meta's console
 * until the clinic has a verified business number, which leaves out exactly the
 * patients who need the link most: the ones who booked over the phone and are
 * not standing at the counter to scan a QR code.
 *
 * These links open the messaging app already on the staff device, with the
 * patient's number and the message filled in, and let staff press send. It is
 * an ordinary personal message, so there is no API, no template approval, no
 * recipient list and no cost.
 */

import { formatDayDate } from './datetime.js'

const COUNTRY_CODE = '91'

// wa.me wants digits only - no +, no spaces.
//
// Leading zeros come off first. A number written the way people say it out loud
// here, "0 63966 34403", is ten digits behind a zero: stripping afterwards
// leaves a bare local number with no country code, and the link then opens a
// chat with the wrong person or none at all.
const toE164Digits = (phone) => {
  const digits = String(phone || '')
    .replace(/\D/g, '')
    .replace(/^0+/, '')

  return digits.length === 10 ? `${COUNTRY_CODE}${digits}` : digits
}

/**
 * The tracking link for a token, when the API did not supply one.
 *
 * The patient site is served from this same origin, so this reproduces exactly
 * what the backend builds from FRONTEND_URL - which is what lets the desk
 * re-send a link for someone already in the queue, not just the token it has
 * just issued.
 */
export function trackingUrlFor(slug, tokenId) {
  return `${window.location.origin}/q/${slug}/${tokenId}`
}

/**
 * A clinic number as a patient would read it: +91 93684 44330.
 *
 * Stored E.164 (+919368444330) is correct but reads as one long string, and a
 * number a patient cannot scan at a glance is one they will not call.
 */
const formatClinicPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '')
  const local = digits.length > 10 ? digits.slice(-10) : digits

  if (local.length !== 10) {
    return String(phone || '').trim()
  }

  return `+91 ${local.slice(0, 5)} ${local.slice(5)}`
}

/**
 * What the patient receives.
 *
 * Written for someone who has just come off a phone call with the desk and may
 * never have used the queue before: it says who is writing, what their number
 * is, what the link does, where to come, and who to call. Every part the clinic
 * has not filled in is left out rather than printed empty.
 */
export function buildHandoffMessage({
  clinicName,
  doctorName,
  tokenNumber,
  trackingUrl,
  address,
  phone,
  mapsUrl,
}) {
  const lines = [
    `Greetings from ${clinicName}${doctorName ? ` (${doctorName})` : ''}.`,
    '',
    `Your token number for today is #${tokenNumber}.`,
    '',
    // One line, not two: messaging apps wrap text themselves, and a newline
    // placed mid-sentence shows up as a break in the middle of a thought.
    'This is your tracking link. It shows your live position in the queue and updates on its own, so you need not wait at the clinic:',
    trackingUrl,
  ]

  if (address) {
    lines.push('', `Location: ${address}`)
  }

  if (mapsUrl) {
    lines.push(mapsUrl)
  }

  if (phone) {
    lines.push('', `For any assistance, please call ${formatClinicPhone(phone)}.`)
  }

  lines.push('', 'Thank you.')

  return lines.join('\n')
}

/**
 * The follow-up reminder, sent by hand from the desk.
 *
 * The automatic version needs a Meta-approved template, which takes days and
 * may never be granted. This one is an ordinary message from the clinic's own
 * WhatsApp, so it works today and reaches any number.
 */
export function buildFollowUpMessage({
  clinicName,
  doctorName,
  patientName,
  dueOn,
  note,
  address,
  phone,
}) {
  const heading = doctorName ? `${clinicName} - ${doctorName}` : clinicName
  const when = formatDayDate(dueOn, { weekday: 'long', month: 'long' })

  const lines = [
    `Greetings from ${heading}.`,
    '',
    `${patientName}, this is a reminder for your follow-up visit on ${when}.`,
  ]

  if (note) {
    lines.push('', `Doctor's note: ${note}`)
  }

  if (address) {
    lines.push('', `Location: ${address}`)
  }

  if (phone) {
    lines.push('', `To reschedule, please call ${formatClinicPhone(phone)}.`)
  }

  lines.push('', 'Thank you.')

  return lines.join('\n')
}

export function whatsappHref(phone, message) {
  return `https://wa.me/${toE164Digits(phone)}?text=${encodeURIComponent(message)}`
}

export function smsHref(phone, message) {
  // iOS wants the body after an &, Android after a ?. Getting this wrong drops
  // the message and opens an empty draft, which staff will not notice until the
  // patient rings back to say nothing arrived.
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent || '')
  const separator = isIos ? '&' : '?'

  return `sms:+${toE164Digits(phone)}${separator}body=${encodeURIComponent(message)}`
}
