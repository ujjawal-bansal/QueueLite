import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  addPatient,
  callIn,
  completeToken,
  getQueueToday,
  logout,
  markNoShow,
  onRetry,
  restoreToken,
} from '../api/queue'
import TokenHandoff from '../components/TokenHandoff'

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
    // Filler text like "Doctor details unavailable" is noise on a screen the
    // front desk stares at all day; show nothing when there is nothing to say.
    doctor: clinic.doctor_name || queue?.doctor_name || queue?.doctor || '',
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

  let currentTokenNumber = queue.current_token_number

  if (updatedToken.status === 'in_progress') {
    currentTokenNumber = updatedToken.token_number
  } else if (previousToken?.status === 'in_progress') {
    currentTokenNumber = null
  }

  return {
    ...queue,
    current_token_number: currentTokenNumber,
    waiting_count: waitingCount,
    tokens: queue.tokens.map((token) => {
      if (token.id === updatedToken.id) {
        return updatedToken
      }

      if (updatedToken.status === 'in_progress' && token.status === 'in_progress') {
        return { ...token, status: 'done' }
      }

      return token
    }),
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

  let currentTokenNumber = queue.current_token_number

  if (status === 'in_progress' && changedToken) {
    currentTokenNumber = changedToken.token_number
  } else if (changedToken?.status === 'in_progress') {
    currentTokenNumber = null
  }

  return {
    ...queue,
    current_token_number: currentTokenNumber,
    waiting_count: waitingCount,
    tokens: queue.tokens.map((token) => {
      if (token.id === tokenId) {
        return { ...token, status }
      }

      if (status === 'in_progress' && token.status === 'in_progress') {
        return { ...token, status: 'done' }
      }

      return token
    }),
  }
}

// The session cookie can expire mid-shift; reloading re-runs the auth gate.
function handleAuthLoss(error) {
  if (error.status === 401) {
    window.location.reload()
    return true
  }

  return false
}

function StaffDashboard() {
  const { slug } = useParams()
  const mountedRef = useRef(false)
  const successTimerRef = useRef(null)
  const undoTimerRef = useRef(null)
  const [queue, setQueue] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [form, setForm] = useState({ patientName: '', patientPhone: '' })
  const [formErrors, setFormErrors] = useState({})
  const [isAdding, setIsAdding] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [issuedToken, setIssuedToken] = useState(null)
  const [pendingTokenId, setPendingTokenId] = useState(null)
  const [undoOffer, setUndoOffer] = useState(null)
  const [retryState, setRetryState] = useState({ retrying: false, attempt: 0, total: 0 })
  const nameInputRef = useRef(null)
  const lastMutationAtRef = useRef(0)

  const loadQueue = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) {
        setIsLoading(true)
      }

      const startedAt = Date.now()

      try {
        const data = await getQueueToday(slug)

        if (!mountedRef.current) {
          return
        }

        // A poll begun before the last action carries pre-action data.
        if (startedAt < lastMutationAtRef.current) {
          return
        }

        setQueue(data)
        setLoadError('')
      } catch (error) {
        if (!mountedRef.current || handleAuthLoss(error)) {
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
      window.clearTimeout(undoTimerRef.current)
    }
  }, [loadQueue])

  useEffect(() => onRetry(setRetryState), [])

  const clinic = useMemo(() => getClinicDetails(queue, slug), [queue, slug])
  const servingToken = useMemo(
    () => (queue?.tokens || []).find((token) => token.status === 'in_progress'),
    [queue],
  )
  const todayTotals = useMemo(() => {
    const tokens = queue?.tokens || []

    return {
      seen: tokens.filter((token) => token.status === 'done').length,
      noShow: tokens.filter((token) => token.status === 'no_show').length,
    }
  }, [queue])
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

      lastMutationAtRef.current = Date.now()

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
      setIssuedToken(token)
      nameInputRef.current?.focus()
      setSuccessMessage(`Token #${token.token_number} assigned`)
      window.clearTimeout(successTimerRef.current)
      successTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) {
          setSuccessMessage('')
        }
      }, 2000)
    } catch (error) {
      if (mountedRef.current && !handleAuthLoss(error)) {
        setFormErrors({ form: error.message })
      }
    } finally {
      if (mountedRef.current) {
        setIsAdding(false)
      }
    }
  }

  async function handleTokenAction(token, action) {
    // A second tap while the first is still in flight would fire the action
    // twice; on Call In that means closing out the wrong patient.
    if (pendingTokenId) {
      return
    }

    const previousQueue = queue
    const optimisticStatusByAction = {
      'call-in': 'in_progress',
      done: 'done',
      'no-show': 'no_show',
      restore: 'waiting',
    }
    const requestByAction = {
      'call-in': callIn,
      done: completeToken,
      'no-show': markNoShow,
      restore: restoreToken,
    }
    const optimisticStatus = optimisticStatusByAction[action]
    const request = requestByAction[action]

    setActionError('')
    setPendingTokenId(token.id)
    setQueue((currentQueue) =>
      setTokenStatus(currentQueue, token.id, optimisticStatus),
    )

    try {
      const updatedToken = await request(slug, token.id)

      lastMutationAtRef.current = Date.now()

      if (mountedRef.current) {
        setQueue((currentQueue) => updateToken(currentQueue, updatedToken))

        if (action === 'no-show' || action === 'done') {
          setUndoOffer({ token: updatedToken, action })
          window.clearTimeout(undoTimerRef.current)
          undoTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) {
              setUndoOffer(null)
            }
          }, 8000)
        } else {
          setUndoOffer(null)
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        setQueue(previousQueue)

        if (!handleAuthLoss(error)) {
          setActionError(error.message)
        }
      }
    } finally {
      if (mountedRef.current) {
        setPendingTokenId(null)
      }
    }
  }

  async function handleUndo() {
    // The action that produced this offer has already finished, so a lingering
    // pending flag must not swallow the undo.
    if (!undoOffer || pendingTokenId) {
      return
    }

    const { token } = undoOffer
    setUndoOffer(null)
    await handleTokenAction(token, 'restore')
  }

  async function handleSignOut() {
    try {
      await logout()
    } finally {
      window.location.reload()
    }
  }

  return (
    <main className="staff-dashboard">
      <header className="clinic-header">
        <div>
          <h1>{clinic.name}</h1>
          {clinic.doctor ? <p>{clinic.doctor}</p> : null}
        </div>
        <div className="header-side">
          <p className="today-label">{getTodayLabel()}</p>
          <button type="button" className="signout-button" onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </header>

      <TokenHandoff token={issuedToken} onDismiss={() => setIssuedToken(null)} />

      <section className="serving-panel" aria-live="polite">
        <div className="serving-details">
          <p>Now Serving</p>
          {queue?.current_token_number ? (
            <strong>#{queue.current_token_number}</strong>
          ) : (
            <strong className="not-started">Queue not started</strong>
          )}
          {servingToken ? (
            <span className="serving-name">{servingToken.patient_name}</span>
          ) : null}
        </div>
        {servingToken ? (
          <button
            type="button"
            className="done-button"
            disabled={Boolean(pendingTokenId)}
            onClick={() => handleTokenAction(servingToken, 'done')}
          >
            {pendingTokenId === servingToken.id ? 'Working...' : 'Mark Done'}
          </button>
        ) : null}
      </section>

      {retryState.retrying ? (
        <p className="reconnect-banner" aria-live="polite">
          Waking the server, this can take up to a minute
          {retryState.total ? ` (${retryState.attempt}/${retryState.total})` : ''}
          ... your last action is still being sent.
        </p>
      ) : null}

      {undoOffer ? (
        <div className="undo-bar" aria-live="polite">
          <span>
            #{undoOffer.token.token_number}{' '}
            {undoOffer.action === 'no-show' ? 'marked no show' : 'marked done'}
          </span>
          <button type="button" className="undo-button" onClick={handleUndo}>
            Undo
          </button>
        </div>
      ) : null}

      {loadError ? <p className="error-banner">{loadError}</p> : null}

      <section className="add-patient">
        <h2>Add Patient</h2>
        <form onSubmit={handleAddPatient} noValidate>
          <label>
            <span>Name</span>
            <input
              ref={nameInputRef}
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
              type="tel"
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

        <p className="today-totals">
          {todayTotals.seen} seen today
          {todayTotals.noShow > 0 ? ` · ${todayTotals.noShow} no show` : ''}
        </p>

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
                    disabled={Boolean(pendingTokenId)}
                    onClick={() => handleTokenAction(token, 'call-in')}
                  >
                    {pendingTokenId === token.id ? 'Working...' : 'Call In'}
                  </button>
                  <button
                    type="button"
                    className="no-show-button"
                    disabled={Boolean(pendingTokenId)}
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
