import { useEffect, useState } from 'react'
import QRCode from 'qrcode/lib/browser'
import {
  buildHandoffMessage,
  smsHref,
  trackingUrlFor,
  whatsappHref,
} from '../lib/handoff'

/**
 * How a patient actually gets their tracking link.
 *
 * Three routes, because no single one reaches everybody: the QR for whoever is
 * standing at the counter, WhatsApp or SMS from the desk's own phone for the
 * patients who booked by call and are not here to scan anything.
 */
function TokenHandoff({
  token,
  clinicName,
  doctorName,
  address,
  phone,
  mapsUrl,
  slug,
  onDismiss,
}) {
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [copied, setCopied] = useState(false)

  // A token opened from the waiting list has no tracking_url on it - only the
  // create response carries one - so fall back to building it.
  const trackingUrl =
    token?.tracking_url || (token ? trackingUrlFor(slug, token.id) : '')

  useEffect(() => {
    let cancelled = false

    if (!trackingUrl) {
      return undefined
    }

    QRCode.toDataURL(trackingUrl, { width: 320, margin: 1 })
      .then((url) => {
        if (!cancelled) {
          setQrDataUrl(url)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrDataUrl('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [trackingUrl])

  if (!token) {
    return null
  }

  const message = buildHandoffMessage({
    clinicName,
    doctorName,
    tokenNumber: token.token_number,
    trackingUrl,
    address,
    phone,
    mapsUrl,
  })

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(trackingUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="token-handoff">
      <div className="handoff-heading">
        <div>
          <p>Token Issued</p>
          <strong>#{token.token_number}</strong>
        </div>
        <button type="button" className="dismiss-button" onClick={onDismiss}>
          Done
        </button>
      </div>

      <p className="handoff-note">
        {token.notified
          ? 'Sent automatically on WhatsApp. You can also send it yourself:'
          : 'Send the tracking link to the patient:'}
      </p>

      {/* Opens the messaging app already on this phone with the number and
          message filled in. Staff press send - it is an ordinary personal
          message, so it reaches any number, unlike the API. */}
      <div className="handoff-send">
        <a
          className="send-whatsapp"
          href={whatsappHref(token.patient_phone, message)}
          target="_blank"
          rel="noreferrer"
        >
          Send on WhatsApp
        </a>
        <a className="send-sms" href={smsHref(token.patient_phone, message)}>
          Send SMS
        </a>
      </div>

      <p className="handoff-note handoff-scan-note">
        Or have the patient scan this at the desk:
      </p>

      {qrDataUrl ? (
        <img className="handoff-qr" src={qrDataUrl} alt="Tracking link QR code" />
      ) : null}

      <button type="button" className="copy-button" onClick={handleCopy}>
        {copied ? 'Link Copied' : 'Copy Tracking Link'}
      </button>
    </section>
  )
}

export default TokenHandoff
