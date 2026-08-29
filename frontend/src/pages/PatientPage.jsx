import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getTokenStatus } from '../api/queue'
import ClinicMark, { ClinicWordmark } from '../components/ClinicMark'

// Once a visit ends nothing about it can change, so polling on is pure waste -
// a phone left open on this page would hammer the API all day.
const TERMINAL_STATUSES = new Set(['done', 'no_show'])

/**
 * How often this page should ask again, by how close the patient is.
 *
 * A fixed nine seconds is what a ten-patient queue can afford. At a hundred it
 * is a hundred phones asking seven times a minute for an answer that, for most
 * of them, will not change for an hour. Someone at the front still gets a
 * near-live page; someone forty back does not need one, and gets a WhatsApp
 * when they do.
 */
function getPollIntervalMs(status, patientsAhead) {
  if (status === 'in_progress' || patientsAhead <= 2) {
    return 10000
  }

  if (patientsAhead <= 10) {
    return 25000
  }

  if (patientsAhead <= 30) {
    return 60000
  }

  return 120000
}

const STATUS_LABELS = {
  waiting: 'Waiting',
  in_progress: 'Your turn',
  done: 'Completed',
  no_show: 'Marked no show',
}

function formatClock(instant) {
  if (!instant) {
    return ''
  }

  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(instant))
    .toLowerCase()
}

// The patient's own name, trimmed to the first word. "Dear Ujjawal" reads like
// the clinic talking to a person; "Dear Ujjawal Bansal" reads like a form.
function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || ''
}

function getHeadline(status, patientsAhead, patientName) {
  const dear = patientName ? `Dear ${firstName(patientName)}, ` : ''
  const sentence = (text) =>
    dear ? dear + text.charAt(0).toLowerCase() + text.slice(1) : text

  if (status === 'in_progress') {
    return sentence("It's your turn, please go in")
  }

  if (status === 'done') {
    return sentence('Your visit is complete')
  }

  if (status === 'no_show') {
    return sentence('You were marked as a no show')
  }

  if (patientsAhead === 0) {
    return sentence("You're next")
  }

  return `${dear}${patientsAhead} ${
    patientsAhead === 1 ? 'patient is' : 'patients are'
  } ahead of you`
}

function getSubtext(status, patientsAhead, readyAt, afterClosing) {
  if (status === 'in_progress') {
    return 'The doctor is ready to see you now.'
  }

  if (status === 'done') {
    return 'Thanks for visiting. You can close this page.'
  }

  if (status === 'no_show') {
    return 'Please check with the front desk to rejoin the queue.'
  }

  if (patientsAhead === 0) {
    return 'Please stay close by. You will be called shortly.'
  }

  // The estimate has run past closing time. Quoting the clock time would be
  // both wrong and reassuring, which is the worst combination.
  if (afterClosing) {
    return 'There are more patients ahead than we usually see before closing. Please check with the front desk about today.'
  }

  // A clock time is the only form of this a patient can act on: it answers
  // "can I go and eat first", which a minute count does not.
  if (readyAt) {
    return `Your turn is expected around ${readyAt}. This updates as the queue moves.`
  }

  return 'This page updates as the queue moves.'
}

function PatientPage() {
  const { slug, tokenId } = useParams()
  const mountedRef = useRef(false)
  const [status, setStatus] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const statusRef = useRef(null)
  const aheadRef = useRef(0)
  const timerRef = useRef(null)

  const loadStatus = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) {
        setIsLoading(true)
      }

      try {
        const data = await getTokenStatus(slug, tokenId)

        if (!mountedRef.current) {
          return
        }

        statusRef.current = data?.token?.status || null
        aheadRef.current = data?.patients_ahead ?? 0
        setStatus(data)
        setLoadError('')
      } catch (error) {
        if (mountedRef.current) {
          setLoadError(error.message)
        }
      } finally {
        if (mountedRef.current && !silent) {
          setIsLoading(false)
        }
      }
    },
    [slug, tokenId],
  )

  useEffect(() => {
    mountedRef.current = true

    // Self-scheduling rather than a fixed interval: the gap to the next poll is
    // decided by the answer the last one gave.
    const run = async (isFirst) => {
      // A backgrounded tab does not need live updates - it refreshes on return,
      // so a poll spent here is one nobody is looking at.
      if (isFirst || document.visibilityState === 'visible') {
        await loadStatus({ silent: !isFirst })
      }

      if (!mountedRef.current || TERMINAL_STATUSES.has(statusRef.current)) {
        return
      }

      timerRef.current = window.setTimeout(
        () => run(false),
        getPollIntervalMs(statusRef.current, aheadRef.current),
      )
    }

    // Deferred by a tick so the first render is not a cascading one.
    timerRef.current = window.setTimeout(() => run(true), 0)

    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        !TERMINAL_STATUSES.has(statusRef.current)
      ) {
        window.clearTimeout(timerRef.current)
        run(false)
      }
    }

    document.addEventListener('visibilitychange', onVisible)

    return () => {
      mountedRef.current = false
      window.clearTimeout(timerRef.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadStatus])

  if (isLoading) {
    return (
      <main className="patient-page">
        <p className="empty-state">Loading your token...</p>
      </main>
    )
  }

  if (loadError) {
    return (
      <main className="patient-page">
        <p className="error-banner">{loadError}</p>
        <button
          type="button"
          className="primary-button"
          onClick={() => loadStatus()}
        >
          Try Again
        </button>
      </main>
    )
  }

  if (!status) {
    return (
      <main className="patient-page">
        <p className="empty-state">Token not found</p>
      </main>
    )
  }

  const { token, clinic, current_token_number: currentTokenNumber } = status
  const patientsAhead = status.patients_ahead || 0
  const isActive = token.status === 'waiting' || token.status === 'in_progress'
  const readyAt = formatClock(status.estimated_ready_at)
  const afterClosing = Boolean(status.estimate_after_closing)

  return (
    <main className={`patient-page status-${token.status}`}>
      <header className="clinic-header">
        <div className="clinic-identity">
          <ClinicMark />
          <div>
            <h1><ClinicWordmark name={clinic?.name || 'Clinic'} /></h1>
            {clinic?.doctor_name ? <p>{clinic.doctor_name}</p> : null}
          </div>
        </div>
      </header>

      <section className="my-token" aria-live="polite">
        <p>Your Token</p>
        <strong>#{token.token_number}</strong>
        <span className={`status-pill status-pill-${token.status}`}>
          {STATUS_LABELS[token.status] || token.status}
        </span>
      </section>

      <section className="patient-status" aria-live="polite">
        <h2>{getHeadline(token.status, patientsAhead, token.patient_name)}</h2>
        <p>{getSubtext(token.status, patientsAhead, readyAt, afterClosing)}</p>
      </section>

      {isActive ? (
        <section className="queue-facts">
          <div>
            <p>Now Serving</p>
            <strong>
              {currentTokenNumber ? `#${currentTokenNumber}` : 'Not started'}
            </strong>
          </div>
          <div>
            <p>Ahead of You</p>
            <strong>{patientsAhead}</strong>
          </div>
          <div>
            <p>Expected</p>
            <strong>{afterClosing ? 'Ask desk' : readyAt || 'Soon'}</strong>
          </div>
        </section>
      ) : null}

      {clinic?.address || clinic?.phone ? (
        <section className="clinic-contact">
          {clinic.address ? <p className="clinic-address">{clinic.address}</p> : null}
          <div className="contact-actions">
            {clinic.phone ? (
              <a className="contact-link" href={`tel:${clinic.phone}`}>
                Call Clinic
              </a>
            ) : null}
            {clinic.maps_url ? (
              <a
                className="contact-link"
                href={clinic.maps_url}
                target="_blank"
                rel="noreferrer"
              >
                Directions
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      <p className="patient-footer">This page updates automatically.</p>
    </main>
  )
}

export default PatientPage
