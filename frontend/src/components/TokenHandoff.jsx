import { useEffect, useState } from 'react'
import QRCode from 'qrcode/lib/browser'

/**
 * Shown right after a token is issued. WhatsApp delivery can be delayed or
 * unconfigured, so the desk always has a QR the patient can scan on the spot.
 */
function TokenHandoff({ token, onDismiss }) {
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false

    if (!token?.tracking_url) {
      return undefined
    }

    QRCode.toDataURL(token.tracking_url, { width: 320, margin: 1 })
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
  }, [token])

  if (!token) {
    return null
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token.tracking_url)
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
          ? 'Sent on WhatsApp. Patient can also scan this:'
          : 'WhatsApp not sent - have the patient scan this to track their turn:'}
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
