import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getBoard } from '../api/queue'

// One screen in the waiting room, plus however many patients look it up on
// their own phones. Ten seconds keeps the number honest without the board
// being a meaningful share of the API's traffic.
const POLL_INTERVAL_MS = 10000

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

const STATUS_TEXT = {
  waiting: 'Waiting',
  in_progress: 'Being seen now',
  done: 'Visit complete',
  no_show: 'Marked no show',
}

/**
 * The public board.
 *
 * Deliberately carries no names and no phone numbers: token numbers run 1, 2,
 * 3... so anyone can type any of them, and the answer must not identify the
 * person holding it.
 */
function BoardPage() {
  const { slug } = useParams()
  const mountedRef = useRef(false)
  const timerRef = useRef(null)
  const [board, setBoard] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [lookupNumber, setLookupNumber] = useState('')

  const load = useCallback(
    async (tokenNumber) => {
      try {
        const data = await getBoard(slug, tokenNumber)

        if (mountedRef.current) {
          setBoard(data)
          setLoadError('')
        }
      } catch (error) {
        if (mountedRef.current) {
          setLoadError(error.message)
        }
      }
    },
    [slug],
  )

  // Re-polls with whatever number is being looked up, so a patient watching
  // their own position sees it move without touching anything.
  useEffect(() => {
    mountedRef.current = true

    const tick = async () => {
      if (document.visibilityState === 'visible') {
        await load(lookupNumber)
      }

      if (mountedRef.current) {
        timerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS)
      }
    }

    timerRef.current = window.setTimeout(tick, 0)

    return () => {
      mountedRef.current = false
      window.clearTimeout(timerRef.current)
    }
  }, [load, lookupNumber])

  function handleLookup(event) {
    event.preventDefault()
    setLookupNumber(tokenInput.trim())
  }

  function handleClear() {
    setTokenInput('')
    setLookupNumber('')
  }

  const lookup = board?.lookup
  const clinic = board?.clinic

  return (
    <main className="board-page">
      <header className="board-header">
        <h1>{clinic?.name || 'Queue'}</h1>
        {clinic?.doctor_name ? <p>{clinic.doctor_name}</p> : null}
      </header>

      {loadError ? <p className="error-banner">{loadError}</p> : null}

      <section className="board-now" aria-live="polite">
        <p>Now Serving</p>
        <strong>
          {board?.current_token_number ? `#${board.current_token_number}` : '--'}
        </strong>
        <span>
          {board
            ? `${board.waiting_count} waiting · ${board.seen_count} seen today`
            : 'Loading...'}
        </span>
      </section>

      {board?.recently_called?.length > 1 ? (
        <section className="board-recent">
          <p>Recently called</p>
          <div className="board-recent-list">
            {board.recently_called.map((number) => (
              <span key={number}>#{number}</span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="board-lookup">
        <h2>Check your number</h2>
        <form onSubmit={handleLookup}>
          <input
            type="text"
            inputMode="numeric"
            value={tokenInput}
            onChange={(event) =>
              setTokenInput(event.target.value.replace(/\D/g, '').slice(0, 4))
            }
            placeholder="Your token number"
            aria-label="Your token number"
          />
          <button type="submit" className="primary-button">
            Check
          </button>
        </form>

        {lookup && !lookup.found ? (
          <p className="board-result board-result-missing">
            No token #{lookup.token_number} today. Please check with the front desk.
          </p>
        ) : null}

        {lookup?.found ? (
          <div className="board-result" aria-live="polite">
            <strong>#{lookup.token_number}</strong>
            <p className="board-result-status">
              {STATUS_TEXT[lookup.status] || lookup.status}
            </p>

            {lookup.status === 'waiting' ? (
              <p className="board-result-detail">
                {lookup.patients_ahead === 0
                  ? "You're next, please stay close by."
                  : `${lookup.patients_ahead} ${
                      lookup.patients_ahead === 1 ? 'patient' : 'patients'
                    } ahead of you`}
                {lookup.patients_ahead > 0 && lookup.estimate_after_closing
                  ? ' · more than we usually see before closing, please check with the desk'
                  : lookup.patients_ahead > 0 && lookup.estimated_ready_at
                    ? ` · around ${formatClock(lookup.estimated_ready_at)}`
                    : ''}
              </p>
            ) : null}

            {lookup.status === 'in_progress' ? (
              <p className="board-result-detail">Please go in.</p>
            ) : null}

            <button type="button" className="board-clear" onClick={handleClear}>
              Clear
            </button>
          </div>
        ) : null}
      </section>

      {clinic?.phone || clinic?.address ? (
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

      <p className="patient-footer">This board updates automatically.</p>
    </main>
  )
}

export default BoardPage
