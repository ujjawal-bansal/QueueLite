import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getQueueToday } from '../api/queue'
import Skeleton from '../components/Skeleton'
import { formatToday } from '../lib/datetime'
import {
  consultMinutes,
  csvFilename,
  formatClock,
  formatMinutes,
  statusLabel,
  summariseDay,
  toCsv,
  waitedMinutes,
} from '../lib/report'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'done', label: 'Seen' },
  { key: 'no_show', label: 'No show' },
  { key: 'open', label: 'Still open' },
]

function matchesFilter(token, filter) {
  if (filter === 'all') {
    return true
  }

  if (filter === 'open') {
    return token.status === 'waiting' || token.status === 'in_progress'
  }

  return token.status === filter
}

/**
 * The end-of-day record: every patient issued a token today, what happened to
 * them, and how long they waited.
 *
 * Reads the same endpoint the dashboard polls, so it needs no extra API and can
 * never disagree with the queue it was opened from.
 */
function ReportPage() {
  const { slug } = useParams()
  const mountedRef = useRef(false)
  const [queue, setQueue] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState('all')

  const load = useCallback(async () => {
    try {
      const data = await getQueueToday(slug)

      if (mountedRef.current) {
        setQueue(data)
        setLoadError('')
      }
    } catch (error) {
      if (mountedRef.current) {
        // The session can lapse mid-shift; reloading re-runs the auth gate.
        if (error.status === 401) {
          window.location.reload()
          return
        }

        setLoadError(error.message)
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [slug])

  useEffect(() => {
    mountedRef.current = true
    const id = window.setTimeout(load, 0)

    return () => {
      mountedRef.current = false
      window.clearTimeout(id)
    }
  }, [load])

  const tokens = useMemo(
    () =>
      [...(queue?.tokens || [])].sort((a, b) => a.token_number - b.token_number),
    [queue],
  )
  const summary = useMemo(() => summariseDay(tokens), [tokens])
  const visible = useMemo(
    () => tokens.filter((token) => matchesFilter(token, filter)),
    [tokens, filter],
  )

  function handleExport() {
    const blob = new Blob([toCsv(tokens)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.href = url
    link.download = csvFilename(slug)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    // Freeing it immediately can cancel the download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <main className="report-page">
      <header className="clinic-header">
        <div>
          <h1>Today&apos;s Report</h1>
          <p>{formatToday()}</p>
        </div>
        <div className="header-side">
          <div className="header-actions">
            <Link className="signout-button" to={`/staff/${slug}`}>
              Back to Queue
            </Link>
          </div>
        </div>
      </header>

      {loadError ? <p className="error-banner">{loadError}</p> : null}
      {isLoading ? <Skeleton rows={5} /> : null}

      {!isLoading ? (
        <>
          <section className="queue-stats">
            <div>
              <p>Tokens</p>
              <strong>{summary.total}</strong>
            </div>
            <div>
              <p>Seen</p>
              <strong>{summary.seen}</strong>
            </div>
            <div>
              <p>No show</p>
              <strong>{summary.noShow}</strong>
            </div>
            <div>
              <p>Still open</p>
              <strong>{summary.open}</strong>
            </div>
          </section>

          <section className="report-meta">
            <div>
              <p>Typical wait</p>
              <strong>{formatMinutes(summary.medianWait)}</strong>
            </div>
            <div>
              <p>Longest wait</p>
              <strong>{formatMinutes(summary.longestWait)}</strong>
            </div>
            <div>
              <p>With doctor</p>
              <strong>{formatMinutes(summary.medianConsult)}</strong>
            </div>
            <div>
              <p>In clinic</p>
              <strong>{formatMinutes(summary.medianTimeInClinic)}</strong>
            </div>
            <div>
              <p>First token</p>
              <strong>{formatClock(summary.firstTokenAt) || '-'}</strong>
            </div>
            <div>
              <p>Last token</p>
              <strong>{formatClock(summary.lastTokenAt) || '-'}</strong>
            </div>
          </section>

          <div className="report-controls">
            <div className="report-filters" role="group" aria-label="Filter patients">
              {FILTERS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={
                    filter === option.key
                      ? 'report-filter report-filter-active'
                      : 'report-filter'
                  }
                  aria-pressed={filter === option.key}
                  onClick={() => setFilter(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="export-button"
              onClick={handleExport}
              disabled={tokens.length === 0}
            >
              Export CSV
            </button>
          </div>

          {visible.length === 0 ? (
            <p className="empty-state">
              {tokens.length === 0
                ? 'No tokens issued today'
                : 'No patients in this group'}
            </p>
          ) : (
            <ul className="report-list">
              {visible.map((token) => (
                <li key={token.id} className={`report-row status-${token.status}`}>
                  <div className="report-row-main">
                    <strong>#{token.token_number}</strong>
                    <div className="report-row-who">
                      <span className="report-name">{token.patient_name}</span>
                      {/* Tappable: at end of day this is how staff follow up
                          with someone who did not turn up. */}
                      <a
                        className="report-phone"
                        href={`tel:+91${token.patient_phone}`}
                      >
                        {token.patient_phone}
                      </a>
                    </div>
                    <span className={`status-pill status-pill-${token.status}`}>
                      {statusLabel(token.status)}
                    </span>
                  </div>

                  <dl className="report-row-times">
                    <div>
                      <dt>Issued</dt>
                      <dd>{formatClock(token.created_at) || '-'}</dd>
                    </div>
                    <div>
                      <dt>Called</dt>
                      <dd>{formatClock(token.called_in_at) || '-'}</dd>
                    </div>
                    <div>
                      <dt>Waited</dt>
                      <dd>{formatMinutes(waitedMinutes(token))}</dd>
                    </div>
                    <div>
                      <dt>With doctor</dt>
                      <dd>{formatMinutes(consultMinutes(token))}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}

          <p className="dashboard-footer">
            Showing {visible.length} of {tokens.length} tokens issued today.
          </p>
        </>
      ) : null}
    </main>
  )
}

export default ReportPage
