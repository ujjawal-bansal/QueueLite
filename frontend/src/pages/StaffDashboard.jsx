import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { addPatient, callIn, getQueueToday, markNoShow } from '../api/queue'

const POLL_INTERVAL_MS = 9000

function formatSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function getClinicDetails(queue, slug) {
  const clinic = queue?.clinic || {}

  return {
    name: clinic.name || queue?.clinic_name || queue?.name || formatSlug(slug),
    doctor:
      clinic.doctor_name ||
      queue?.doctor_name ||
      queue?.doctor ||
      'Doctor details unavailable',
  }
}

function getTodayLabel() {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date())
}

function validateForm(form) {
  const errors = {}
  const patientName = form.patientName.trim()
  const patientPhone = form.patientPhone.trim()

  if (patientName.length < 2) {
    errors.patientName = 'Enter at least 2 characters'
  }

  if (!/^\d{10}$/.test(patientPhone)) {
    errors.patientPhone = 'Enter exactly 10 digits'
  }

  return errors
}

function updateToken(queue, updatedToken) {
  if (!queue) {
    return queue
  }

  const previousToken = queue.tokens.find((token) => token.id === updatedToken.id)
  const wasWaiting = previousToken?.status === 'waiting'
  const isWaiting = updatedToken.status === 'waiting'
  let waitingCount = queue.waiting_count

  if (wasWaiting && !isWaiting) {
    waitingCount = Math.max(0, waitingCount - 1)
  } else if (!wasWaiting && isWaiting) {
    waitingCount += 1
  }

  return {
    ...queue,
    current_token_number:
      updatedToken.status === 'in_progress'
        ? updatedToken.token_number
        : queue.current_token_number,
    waiting_count: waitingCount,
    tokens: queue.tokens.map((token) =>
      token.id === updatedToken.id ? updatedToken : token,
    ),
  }
}

function setTokenStatus(queue, tokenId, status) {
  if (!queue) {
    return queue
  }

  const changedToken = queue.tokens.find((token) => token.id === tokenId)
  const wasWaiting = changedToken?.status === 'waiting'
  const isWaiting = status === 'waiting'
  let waitingCount = queue.waiting_count

  if (wasWaiting && !isWaiting) {
    waitingCount = Math.max(0, waitingCount - 1)
  } else if (!wasWaiting && isWaiting) {
    waitingCount += 1
  }

  return {
    ...queue,
    current_token_number:
      status === 'in_progress' && changedToken
        ? changedToken.token_number
        : queue.current_token_number,
    waiting_count: waitingCount,
    tokens: queue.tokens.map((token) =>
      token.id === tokenId ? { ...token, status } : token,
    ),
  }
}

function StaffDashboard() {
  const { slug } = useParams()
  const mountedRef = useRef(false)
  const successTimerRef = useRef(null)
  const [queue, setQueue] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [form, setForm] = useState({ patientName: '', patientPhone: '' })
  const [formErrors, setFormErrors] = useState({})
  const [isAdding, setIsAdding] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')
  const [actionError, setActionError] = useState('')

  const loadQueue = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) {
        setIsLoading(true)
      }

      try {
        const data = await getQueueToday(slug)

        if (!mountedRef.current) {
          return
        }

        setQueue(data)
        setLoadError('')
      } catch (error) {
        if (!mountedRef.current) {
          return
        }

        setLoadError(error.message)
      } finally {
        if (mountedRef.current && !silent) {
          setIsLoading(false)
        }
      }
    },
    [slug],
  )

  useEffect(() => {
    mountedRef.current = true
    const initialLoadId = window.setTimeout(() => {
      loadQueue()
    }, 0)

    const intervalId = window.setInterval(() => {
      loadQueue({ silent: true })
    }, POLL_INTERVAL_MS)

    return () => {
      mountedRef.current = false
      window.clearTimeout(initialLoadId)
      window.clearInterval(intervalId)
      window.clearTimeout(successTimerRef.current)
    }
  }, [loadQueue])

  const clinic = useMemo(() => getClinicDetails(queue, slug), [queue, slug])
  const waitingTokens = useMemo(
    () =>
      (queue?.tokens || [])
        .filter((token) => token.status === 'waiting')
        .sort((a, b) => a.token_number - b.token_number),
    [queue],
  )

  function updateFormField(field, value) {
    setForm((currentForm) => ({ ...currentForm, [field]: value }))
    setFormErrors((currentErrors) => ({ ...currentErrors, [field]: '' }))
  }

  async function handleAddPatient(event) {
    event.preventDefault()

    const errors = validateForm(form)
    setFormErrors(errors)

    if (Object.keys(errors).length > 0) {
      return
    }

    setIsAdding(true)
    setActionError('')
    setSuccessMessage('')

    try {
      const token = await addPatient(
        slug,
        form.patientName.trim(),
        form.patientPhone.trim(),
      )

      if (!mountedRef.current) {
        return
      }

      setQueue((currentQueue) => {
        if (!currentQueue) {
          return currentQueue
        }

        return {
          ...currentQueue,
          waiting_count: currentQueue.waiting_count + 1,
          tokens: [...currentQueue.tokens, token].sort(
            (a, b) => a.token_number - b.token_number,
          ),
        }
      })

      setForm({ patientName: '', patientPhone: '' })
      setFormErrors({})
      setSuccessMessage(`Token #${token.token_number} assigned`)
      window.clearTimeout(successTimerRef.current)
      successTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) {
          setSuccessMessage('')
        }
      }, 2000)
    } catch (error) {
      if (mountedRef.current) {
        setFormErrors({ form: error.message })
      }
    } finally {
      if (mountedRef.current) {
        setIsAdding(false)
      }
    }
  }

  async function handleTokenAction(token, action) {
    const previousQueue = queue
    const optimisticStatus = action === 'call-in' ? 'in_progress' : 'no_show'
    const request = action === 'call-in' ? callIn : markNoShow

    setActionError('')
    setQueue((currentQueue) =>
      setTokenStatus(currentQueue, token.id, optimisticStatus),
    )

    try {
      const updatedToken = await request(slug, token.id)

      if (mountedRef.current) {
        setQueue((currentQueue) => updateToken(currentQueue, updatedToken))
      }
    } catch (error) {
      if (mountedRef.current) {
        setQueue(previousQueue)
        setActionError(error.message)
      }
    }
  }

  return (
    <main className="staff-dashboard">
      <header className="clinic-header">
        <div>
          <h1>{clinic.name}</h1>
          <p>{clinic.doctor}</p>
        </div>
        <p className="today-label">{getTodayLabel()}</p>
      </header>

      <section className="serving-panel" aria-live="polite">
        <p>Now Serving</p>
        {queue?.current_token_number ? (
          <strong>#{queue.current_token_number}</strong>
        ) : (
          <strong className="not-started">Queue not started</strong>
        )}
      </section>

      {loadError ? <p className="error-banner">{loadError}</p> : null}

      <section className="add-patient">
        <h2>Add Patient</h2>
        <form onSubmit={handleAddPatient} noValidate>
          <label>
            <span>Name</span>
            <input
              type="text"
              value={form.patientName}
              onChange={(event) =>
                updateFormField('patientName', event.target.value)
              }
              minLength={2}
              required
              autoComplete="name"
              aria-invalid={Boolean(formErrors.patientName)}
            />
            {formErrors.patientName ? (
              <small>{formErrors.patientName}</small>
            ) : null}
          </label>

          <label>
            <span>Phone</span>
            <input
              type="number"
              value={form.patientPhone}
              onChange={(event) =>
                updateFormField(
                  'patientPhone',
                  event.target.value.replace(/\D/g, '').slice(0, 10),
                )
              }
              inputMode="numeric"
              required
              aria-invalid={Boolean(formErrors.patientPhone)}
            />
            {formErrors.patientPhone ? (
              <small>{formErrors.patientPhone}</small>
            ) : null}
          </label>

          {formErrors.form ? <p className="form-error">{formErrors.form}</p> : null}
          {successMessage ? (
            <p className="success-message" aria-live="polite">
              {successMessage}
            </p>
          ) : null}

          <button type="submit" className="primary-button" disabled={isAdding}>
            {isAdding ? 'Adding...' : 'Add to Queue'}
          </button>
        </form>
      </section>

      <section className="waiting-list">
        <div className="waiting-heading">
          <h2>Waiting List</h2>
          <span>{queue?.waiting_count || 0} waiting</span>
        </div>

        {actionError ? <p className="error-banner">{actionError}</p> : null}

        {isLoading ? <p className="empty-state">Loading queue...</p> : null}

        {!isLoading && waitingTokens.length === 0 ? (
          <p className="empty-state">No patients waiting</p>
        ) : null}

        {!isLoading && waitingTokens.length > 0 ? (
          <ul>
            {waitingTokens.map((token) => (
              <li key={token.id} className="queue-row">
                <div className="token-details">
                  <strong>#{token.token_number}</strong>
                  <span>{token.patient_name}</span>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="call-button"
                    onClick={() => handleTokenAction(token, 'call-in')}
                  >
                    Call In
                  </button>
                  <button
                    type="button"
                    className="no-show-button"
                    onClick={() => handleTokenAction(token, 'no-show')}
                  >
                    No Show
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  )
}

export default StaffDashboard
