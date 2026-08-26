import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getTokenStatus } from '../api/queue'

const POLL_INTERVAL_MS = 9000
const MINUTES_PER_PATIENT = 5

// Once a visit ends nothing about it can change, so polling on is pure waste -
// a phone left open on this page would hammer the API all day. The whole
// waiting room also shares one clinic IP, so those wasted calls come out of a
// budget everyone else needs.
const TERMINAL_STATUSES = new Set(['done', 'no_show'])

const STATUS_LABELS = {
  waiting: 'Waiting',
  in_progress: 'Your turn',
  done: 'Completed',
  no_show: 'Marked no show',
}

function getHeadline(status, patientsAhead) {
  if (status === 'in_progress') {
    return "It's your turn — please go in"
  }

  if (status === 'done') {
    return 'Your visit is complete'
  }

  if (status === 'no_show') {
    return 'You were marked as a no show'
  }

  if (patientsAhead === 0) {
    return "You're next"
  }

  return `${patientsAhead} ${patientsAhead === 1 ? 'patient' : 'patients'} ahead of you`
}

function getSubtext(status, patientsAhead) {
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
    return 'Please stay close by — you will be called shortly.'
  }

  return `Roughly ${patientsAhead * MINUTES_PER_PATIENT} minutes of wait, based on ${MINUTES_PER_PATIENT} minutes per patient.`
}

function PatientPage() {
  const { slug, tokenId } = useParams()
  const mountedRef = useRef(false)
  const [status, setStatus] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const statusRef = useRef(null)

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
    const initialLoadId = window.setTimeout(() => {
      loadStatus()
    }, 0)

    const intervalId = window.setInterval(() => {
      if (TERMINAL_STATUSES.has(statusRef.current)) {
        return
      }

      // A backgrounded tab does not need live updates; refresh on return.
      if (document.visibilityState === 'hidden') {
        return
      }

      loadStatus({ silent: true })
    }, POLL_INTERVAL_MS)

    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        !TERMINAL_STATUSES.has(statusRef.current)
      ) {
        loadStatus({ silent: true })
      }
    }

    document.addEventListener('visibilitychange', onVisible)

    return () => {
      mountedRef.current = false
      window.clearTimeout(initialLoadId)
      window.clearInterval(intervalId)
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

  return (
    <main className={`patient-page status-${token.status}`}>
      <header className="clinic-header">
        <div>
          <h1>{clinic?.name || 'Clinic'}</h1>
          {clinic?.doctor_name ? <p>{clinic.doctor_name}</p> : null}
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
        <h2>{getHeadline(token.status, patientsAhead)}</h2>
        <p>{getSubtext(token.status, patientsAhead)}</p>
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
            <p>Total Waiting</p>
            <strong>{status.waiting_count || 0}</strong>
          </div>
        </section>
      ) : null}

      <p className="patient-footer">
        {token.patient_name} · This page updates automatically.
      </p>
    </main>
  )
}

export default PatientPage
