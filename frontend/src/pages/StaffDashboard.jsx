import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  addPatient,
  callNext,
  completeToken,
  getQueueToday,
  logout,
  addFollowUp,
  markNoShow,
  onRetry,
  pushBackToken,
  restoreToken,
} from '../api/queue'
import TokenHandoff from '../components/TokenHandoff'
import Skeleton from '../components/Skeleton'
import { formatClock, formatToday } from '../lib/datetime'
import ClinicMark, { ClinicWordmark } from '../components/ClinicMark'
import PushBackPicker from '../components/PushBackPicker'
import FollowUpPrompt from '../components/FollowUpPrompt'
import {
  addTokenToQueue,
  setTokenStatus,
  updateToken,
  waitingInOrder,
} from '../lib/queueState'

const POLL_INTERVAL_MS = 9000

// A hundred rows is more than anyone reads. The desk works from the front of
// the queue and from search; the rest is there to be counted, not scanned.
const VISIBLE_WAITING = 25


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
    // The slug is the last resort, for the moment before the first load lands
    // or if it fails: "Dev Eye Care" reads better than an empty header.
    name: clinic.name || formatSlug(slug),
    // Filler text like "Doctor details unavailable" is noise on a screen the
    // front desk stares at all day; show nothing when there is nothing to say.
    doctor: clinic.doctor_name || '',
    // Not shown on the dashboard - these go into the message the desk sends a
    // patient who is not standing at the counter.
    address: clinic.address || '',
    phone: clinic.phone || '',
    mapsUrl: clinic.maps_url || '',
  }
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

// Matches how staff actually search at a desk: a token number, the start of a
// name, or the last few digits of the phone the patient just read out.
function matchesSearch(token, query) {
  if (!query) {
    return true
  }

  const needle = query.trim().toLowerCase()

  if (!needle) {
    return true
  }

  if (token.patient_name.toLowerCase().includes(needle)) {
    return true
  }

  const isNumeric = /^\d+$/.test(needle)

  if (!isNumeric) {
    return false
  }

  // A typed number is either the token or the tail of a phone. Prefixing the
  // token match rather than substring-matching it keeps "12" off #112 and
  // #120, which at this size would bury the row being looked for.
  return (
    String(token.token_number).startsWith(needle) ||
    (needle.length >= 3 && String(token.patient_phone || '').includes(needle))
  )
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
  const [search, setSearch] = useState('')
  const [showAllWaiting, setShowAllWaiting] = useState(false)
  const [showNoShows, setShowNoShows] = useState(false)
  // Which row is currently asking "after how many patients?"
  const [pushBackFor, setPushBackFor] = useState(null)
  // The visit just marked done, while the doctor's instruction is still fresh.
  const [followUpFor, setFollowUpFor] = useState(null)
  const [isSavingFollowUp, setIsSavingFollowUp] = useState(false)
  const [followUpError, setFollowUpError] = useState('')
  const nameInputRef = useRef(null)
  const lastMutationAtRef = useRef(0)
  // A poll that lands while a write is still in flight cannot be trusted: it
  // may already contain the row the write is about to report, or may predate
  // it. Either way the optimistic update is about to apply on top.
  const mutationsInFlightRef = useRef(0)

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

        // A write is still running. Its response is the authority on what
        // changed, and applying this in the meantime double-counts the row the
        // write is about to add.
        if (mutationsInFlightRef.current > 0) {
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
      total: tokens.length,
    }
  }, [queue])
  const waitingTokens = useMemo(
    () => waitingInOrder(queue?.tokens || []),
    [queue],
  )
  const noShowTokens = useMemo(
    () =>
      (queue?.tokens || [])
        .filter((token) => token.status === 'no_show')
        .sort((a, b) => a.token_number - b.token_number),
    [queue],
  )
  const matchingTokens = useMemo(
    () => waitingTokens.filter((token) => matchesSearch(token, search)),
    [waitingTokens, search],
  )
  // Searching means looking for one specific patient, so the cap that keeps the
  // idle list short would only hide the row they are after.
  const visibleTokens =
    search.trim() || showAllWaiting
      ? matchingTokens
      : matchingTokens.slice(0, VISIBLE_WAITING)
  const hiddenCount = matchingTokens.length - visibleTokens.length

  // How long the last stretch of patients actually took, so the desk can tell a
  // patient when to come back rather than guessing.
  const pace = queue?.minutes_per_patient
  // Worth saying out loud: an estimate carried over from last week is a
  // different thing from one measured this morning, and the desk is the one
  // repeating it to patients.
  const paceSourceLabel = {
    clinic: 'clinic average',
    today: 'measured today',
    history: 'from recent days',
    default: 'clinic average',
  }[queue?.pace_source] || ''
  const reminderLead = queue?.reminder_lead_patients ?? 0
  // Only worth mentioning if a message can actually be delivered.
  const autoReminders = Boolean(queue?.auto_reminders)
  const nextToken = waitingTokens[0]

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
    mutationsInFlightRef.current += 1

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

      setQueue((currentQueue) => addTokenToQueue(currentQueue, token))

      setForm({ patientName: '', patientPhone: '' })
      setFormErrors({})
      setIssuedToken(token)
      nameInputRef.current?.focus()

      // The number alone is not what the patient asks at the desk - they ask
      // how long, and by #80 that answer is the whole point of the queue.
      const readyAt = formatClock(token.estimated_ready_at)

      if (token.estimate_after_closing) {
        // Said while the patient is still at the counter, which is the only
        // moment the desk can offer them tomorrow morning instead.
        setSuccessMessage(
          `Token #${token.token_number} - ${token.patients_ahead} ahead, likely past closing`,
        )
      } else {
        setSuccessMessage(
          readyAt && token.patients_ahead > 0
            ? `Token #${token.token_number} - around ${readyAt}, ${token.patients_ahead} ahead`
            : `Token #${token.token_number} assigned`,
        )
      }
      window.clearTimeout(successTimerRef.current)
      successTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) {
          setSuccessMessage('')
        }
      }, 4000)
    } catch (error) {
      if (mountedRef.current && !handleAuthLoss(error)) {
        setFormErrors({ form: error.message })
      }
    } finally {
      mutationsInFlightRef.current -= 1

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
      done: 'done',
      'no-show': 'no_show',
      restore: 'waiting',
    }
    const requestByAction = {
      done: completeToken,
      'no-show': markNoShow,
      restore: restoreToken,
    }
    const optimisticStatus = optimisticStatusByAction[action]
    const request = requestByAction[action]

    setActionError('')
    setPendingTokenId(token.id)
    mutationsInFlightRef.current += 1
    setQueue((currentQueue) =>
      setTokenStatus(currentQueue, token.id, optimisticStatus),
    )

    try {
      const updatedToken = await request(slug, token.id)

      lastMutationAtRef.current = Date.now()

      if (mountedRef.current) {
        setQueue((currentQueue) => updateToken(currentQueue, updatedToken))

        if (action === 'done') {
          setFollowUpFor(updatedToken)
        }

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
      mutationsInFlightRef.current -= 1

      if (mountedRef.current) {
        setPendingTokenId(null)
      }
    }
  }

  /**
   * Calls in whoever the server says is at the front.
   *
   * Deliberately not "call in waitingTokens[0]": with the desk open on a phone
   * and a tablet at once, this screen's idea of the front can be nine seconds
   * stale, and calling in an already-seen patient skips a real one.
   */
  async function handleCallNext() {
    if (pendingTokenId || !nextToken) {
      return
    }

    const previousQueue = queue

    setActionError('')
    setPendingTokenId(nextToken.id)
    mutationsInFlightRef.current += 1
    setQueue((currentQueue) =>
      setTokenStatus(currentQueue, nextToken.id, 'in_progress'),
    )

    try {
      const updatedToken = await callNext(slug)

      lastMutationAtRef.current = Date.now()

      if (mountedRef.current) {
        // Reconcile from before the guess: if the server called in someone
        // else, applying its answer on top of the optimistic change would
        // leave two patients marked as being seen.
        setQueue(updateToken(previousQueue, updatedToken))
        setUndoOffer(null)
      }
    } catch (error) {
      if (mountedRef.current) {
        setQueue(previousQueue)

        if (!handleAuthLoss(error)) {
          setActionError(error.message)
        }
      }
    } finally {
      mutationsInFlightRef.current -= 1

      if (mountedRef.current) {
        setPendingTokenId(null)
      }
    }
  }

  /**
   * Puts a patient who missed their turn back into the queue, a few places down.
   *
   * The case this exists for: called, did not appear, marked a no-show, and
   * then walks in twenty minutes later. Restoring them plainly would land them
   * at the *front*, because their token number is the lowest one still waiting,
   * ahead of everybody who has been sitting there the whole time.
   */
  async function handlePushBack(token, places) {
    if (pendingTokenId) {
      return
    }

    const previousQueue = queue

    setActionError('')
    setPushBackFor(null)
    setPendingTokenId(token.id)
    mutationsInFlightRef.current += 1

    try {
      const updatedToken = await pushBackToken(slug, token.id, places)

      lastMutationAtRef.current = Date.now()

      if (mountedRef.current) {
        // Reconcile from before the action: a push-back reorders the queue, and
        // only the server knows where the patient landed.
        setQueue(updateToken(previousQueue, updatedToken))
        setUndoOffer(null)
        setSuccessMessage(
          `#${updatedToken.token_number} moved back ${places} ${
            places === 1 ? 'patient' : 'patients'
          }`,
        )
        window.clearTimeout(successTimerRef.current)
        successTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current) {
            setSuccessMessage('')
          }
        }, 3000)
      }
    } catch (error) {
      if (mountedRef.current) {
        setQueue(previousQueue)

        if (!handleAuthLoss(error)) {
          setActionError(error.message)
        }
      }
    } finally {
      mutationsInFlightRef.current -= 1

      if (mountedRef.current) {
        setPendingTokenId(null)
      }
    }
  }

  async function handleSaveFollowUp(token, days, note) {
    setIsSavingFollowUp(true)
    setFollowUpError('')

    try {
      await addFollowUp(slug, token.id, days, note)

      if (mountedRef.current) {
        setFollowUpFor(null)
        setFollowUpError('')
        setSuccessMessage(
          `#${token.token_number} to return in ${days} ${days === 1 ? 'day' : 'days'}`,
        )
        window.clearTimeout(successTimerRef.current)
        successTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current) {
            setSuccessMessage('')
          }
        }, 4000)
      }
    } catch (error) {
      // Reported inside the follow-up panel, beside the thing that failed, and
      // the panel stays open so the note and interval are not lost to a retry.
      if (mountedRef.current && !handleAuthLoss(error)) {
        setFollowUpError(error.message)
      }
    } finally {
      if (mountedRef.current) {
        setIsSavingFollowUp(false)
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
        <div className="clinic-identity">
          <ClinicMark />
          <div>
            <h1><ClinicWordmark name={clinic.name} /></h1>
            {clinic.doctor ? <p>{clinic.doctor}</p> : null}
          </div>
        </div>
        <div className="header-side">
          <p className="today-label">{formatToday()}</p>
          <div className="header-actions">
            <Link className="signout-button" to={`/staff/${slug}/follow-ups`}>
              Follow-ups
            </Link>
            <Link className="signout-button" to={`/staff/${slug}/today`}>
              Report
            </Link>
            <button type="button" className="signout-button" onClick={handleSignOut}>
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <TokenHandoff
        token={issuedToken}
        clinicName={clinic.name}
        doctorName={clinic.doctor}
        address={clinic.address}
        phone={clinic.phone}
        mapsUrl={clinic.mapsUrl}
        slug={slug}
        onDismiss={() => setIssuedToken(null)}
      />

      <div className="dashboard-body">
        <div className="dashboard-col-primary">
      {followUpFor ? (
        <FollowUpPrompt
          token={followUpFor}
          isSaving={isSavingFollowUp}
          error={followUpError}
          onSave={handleSaveFollowUp}
          onSkip={() => {
            setFollowUpFor(null)
            setFollowUpError('')
          }}
        />
      ) : null}

      <section className="serving-panel" aria-live="polite">
        <div className="serving-details">
          <p>Now Serving</p>
          {queue?.current_token_number ? (
            <strong key={queue.current_token_number} className="serving-now">
              #{queue.current_token_number}
            </strong>
          ) : (
            <strong className="not-started">Queue not started</strong>
          )}
          {servingToken ? (
            <span className="serving-name">{servingToken.patient_name}</span>
          ) : null}
        </div>
        {/* Every queue action lives here, and only here. The desk works one
            patient at a time, so repeating these on all hundred rows gave a
            hundred chances to tap the wrong one. */}
        <div className="serving-actions">
          <button
            type="button"
            className="call-button"
            disabled={Boolean(pendingTokenId) || !nextToken}
            onClick={handleCallNext}
          >
            {nextToken ? `Call In #${nextToken.token_number}` : 'Nobody waiting'}
          </button>
          <button
            type="button"
            className="done-button"
            disabled={Boolean(pendingTokenId) || !servingToken}
            onClick={() => handleTokenAction(servingToken, 'done')}
          >
            {servingToken && pendingTokenId === servingToken.id
              ? 'Working...'
              : 'Done'}
          </button>
          {/* Called, but nobody came to the door. Where they rejoin the queue
              is decided if and when they turn up. */}
          <button
            type="button"
            className="no-show-button"
            disabled={Boolean(pendingTokenId) || !servingToken}
            onClick={() => handleTokenAction(servingToken, 'no-show')}
          >
            No Show
          </button>
        </div>
      </section>

      <section className="queue-stats" aria-live="polite">
        <div>
          <p>Waiting</p>
          <strong>{queue?.waiting_count || 0}</strong>
        </div>
        <div>
          <p>Seen</p>
          <strong>{todayTotals.seen}</strong>
        </div>
        <div>
          <p>No show</p>
          <strong>{todayTotals.noShow}</strong>
        </div>
        <div>
          <p>Per patient</p>
          <strong>{pace ? `${pace}m` : '--'}</strong>
          {paceSourceLabel ? (
            <small className="stat-note">{paceSourceLabel}</small>
          ) : null}
        </div>
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

        </div>

        <div className="dashboard-col-secondary">
      <section className="waiting-list">
        <div className="waiting-heading">
          <h2>Waiting List</h2>
          <span>{queue?.waiting_count || 0} waiting</span>
        </div>

        {waitingTokens.length > VISIBLE_WAITING ? (
          <input
            type="search"
            className="queue-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, token or phone"
            aria-label="Search the waiting list"
          />
        ) : null}

        {actionError ? <p className="error-banner">{actionError}</p> : null}

        {isLoading ? <Skeleton rows={4} /> : null}

        {!isLoading && matchingTokens.length === 0 ? (
          <p className="empty-state">
            {search.trim() ? 'No patient matches that' : 'No patients waiting'}
          </p>
        ) : null}

        {!isLoading && visibleTokens.length > 0 ? (
          <ul>
            {visibleTokens.map((token, index) => (
              <li key={token.id} className="queue-row">
                {/* Tapping the patient re-opens the handoff panel. "Link
                    nahi aaya" is a routine call-back, and without this the
                    desk has no way to send it a second time. */}
                <button
                  type="button"
                  className="token-details token-details-button"
                  onClick={() => setIssuedToken(token)}
                  title="Send this patient their tracking link"
                >
                  <strong>#{token.token_number}</strong>
                  <span>{token.patient_name}</span>
                  {/* Position is what the patient asks about, and past the
                      first screenful the row order stops answering it. */}
                  {!search.trim() && index > 0 ? (
                    <small className="row-position">{index} ahead</small>
                  ) : null}
                  {token.heads_up_sent_at || token.turn_notified_at ? (
                    <small className="row-notified" title="Reminder sent on WhatsApp">
                      Reminded
                    </small>
                  ) : null}
                </button>
                {/* No action here on purpose: the desk calls patients in
                    order from the panel above. Tapping the row re-sends this
                    patient their tracking link. */}
                <span className="row-send-hint" aria-hidden="true">
                  Send link
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {hiddenCount > 0 ? (
          <button
            type="button"
            className="show-all-button"
            onClick={() => setShowAllWaiting(true)}
          >
            Show all {matchingTokens.length} waiting
          </button>
        ) : null}

        {showAllWaiting && !search.trim() && waitingTokens.length > VISIBLE_WAITING ? (
          <button
            type="button"
            className="show-all-button"
            onClick={() => setShowAllWaiting(false)}
          >
            Show fewer
          </button>
        ) : null}
      </section>

      {noShowTokens.length > 0 ? (
        <section className="no-show-list">
          <button
            type="button"
            className="section-toggle"
            aria-expanded={showNoShows}
            onClick={() => setShowNoShows((shown) => !shown)}
          >
            {showNoShows ? 'Hide' : 'Show'} {noShowTokens.length} no show
            {noShowTokens.length === 1 ? '' : 's'}
          </button>

          {/* A patient who missed their call and turns up twenty minutes later
              is routine at this volume; without this their token is gone for
              good and the desk has to issue them a new number at the back. */}
          {showNoShows ? (
            <ul>
              {noShowTokens.map((token) => (
                <li key={token.id} className="queue-row">
                  <div className="token-details">
                    <strong>#{token.token_number}</strong>
                    <span>{token.patient_name}</span>
                  </div>
                  {pushBackFor === token.id ? (
                    <PushBackPicker
                      token={token}
                      disabled={Boolean(pendingTokenId)}
                      onChoose={handlePushBack}
                      onCancel={() => setPushBackFor(null)}
                    />
                  ) : (
                    <div className="row-actions">
                      {/* Not a plain restore: their token number is the lowest
                          one still waiting, so putting them back untouched
                          would land them at the front, ahead of everyone who
                          has been sitting there the whole time. */}
                      <button
                        type="button"
                        className="restore-button"
                        disabled={Boolean(pendingTokenId)}
                        onClick={() => setPushBackFor(token.id)}
                      >
                        {pendingTokenId === token.id ? 'Working...' : 'Back to Queue'}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

        </div>
      </div>

      <p className="dashboard-footer">
        {todayTotals.total} tokens today
        {autoReminders && reminderLead > 0
          ? ` · patients are messaged when ${reminderLead} away`
          : ''}
      </p>
    </main>
  )
}

export default StaffDashboard
