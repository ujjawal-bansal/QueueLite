import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  cancelFollowUp,
  completeFollowUp,
  getClinic,
  getFollowUps,
} from '../api/queue'
import { buildFollowUpMessage, smsHref, whatsappHref } from '../lib/handoff'
import Skeleton from '../components/Skeleton'
import { formatDayDate } from '../lib/datetime'

function describeDue(daysUntil) {
  if (daysUntil < 0) {
    const overdue = Math.abs(daysUntil)
    return `${overdue} ${overdue === 1 ? 'day' : 'days'} overdue`
  }

  if (daysUntil === 0) {
    return 'Due today'
  }

  if (daysUntil === 1) {
    return 'Due tomorrow'
  }

  return `In ${daysUntil} days`
}

// Overdue first: a patient who did not come back is the one the clinic most
// needs to chase, and burying them below next month's appointments is how they
// get forgotten.
const GROUPS = [
  { key: 'overdue', label: 'Overdue', match: (f) => f.days_until < 0 },
  { key: 'today', label: 'Due today', match: (f) => f.days_until === 0 },
  { key: 'soon', label: 'This week', match: (f) => f.days_until > 0 && f.days_until <= 7 },
  { key: 'later', label: 'Later', match: (f) => f.days_until > 7 },
]

function FollowUpsPage() {
  const { slug } = useParams()
  const mountedRef = useRef(false)
  const [followUps, setFollowUps] = useState([])
  const [clinic, setClinic] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [pendingId, setPendingId] = useState(null)

  const load = useCallback(async () => {
    try {
      const [data, clinicData] = await Promise.all([
        getFollowUps(slug),
        getClinic().catch(() => null),
      ])

      if (mountedRef.current) {
        setFollowUps(data.follow_ups || [])
        setClinic(clinicData)
        setLoadError('')
      }
    } catch (error) {
      if (mountedRef.current) {
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

  const grouped = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        items: followUps.filter(group.match),
      })).filter((group) => group.items.length > 0),
    [followUps],
  )

  async function handleUpdate(followUp, action) {
    if (pendingId) {
      return
    }

    setPendingId(followUp.id)

    const request = action === 'done' ? completeFollowUp : cancelFollowUp
    const previous = followUps

    // Optimistic: it leaves the list either way.
    setFollowUps((current) => current.filter((item) => item.id !== followUp.id))

    try {
      await request(slug, followUp.id)
    } catch (error) {
      if (mountedRef.current) {
        setFollowUps(previous)
        setLoadError(error.message)
      }
    } finally {
      if (mountedRef.current) {
        setPendingId(null)
      }
    }
  }

  const messageFor = (followUp) =>
    buildFollowUpMessage({
      clinicName: clinic?.name || 'the clinic',
      doctorName: clinic?.doctor_name,
      patientName: followUp.patient_name,
      dueOn: followUp.due_on,
      note: followUp.note,
      address: clinic?.address,
      phone: clinic?.phone,
    })

  return (
    <main className="report-page">
      <header className="clinic-header">
        <div>
          <h1>Follow-ups</h1>
          <p>{followUps.length} open</p>
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
      {isLoading ? <Skeleton rows={3} /> : null}

      {/* Nothing is sent automatically. This is the clinic's own list to work
          through, and the buttons on each patient open the desk's WhatsApp or
          SMS with the message ready to send. */}
      {!isLoading && followUps.length > 0 ? (
        <p className="reminder-note">
          Patients are not messaged automatically. Use the buttons on each
          patient to contact them from the clinic&apos;s own WhatsApp or SMS.
        </p>
      ) : null}

      {!isLoading && followUps.length === 0 ? (
        <p className="empty-state">No follow-ups scheduled</p>
      ) : null}

      {grouped.map((group) => (
        <section key={group.key} className="follow-up-group">
          <h2>
            {group.label} <span>{group.items.length}</span>
          </h2>

          <ul className="report-list">
            {group.items.map((followUp) => (
              <li
                key={followUp.id}
                className={`report-row follow-up-row follow-up-${group.key}`}
              >
                <div className="report-row-main">
                  <div className="report-row-who">
                    <span className="report-name">{followUp.patient_name}</span>
                    <a
                      className="report-phone"
                      href={`tel:+91${followUp.patient_phone}`}
                    >
                      {followUp.patient_phone}
                    </a>
                  </div>
                  <span className="follow-up-due">
                    {formatDayDate(followUp.due_on)}
                    <small>{describeDue(followUp.days_until)}</small>
                  </span>
                </div>

                {followUp.note ? (
                  <p className="follow-up-note">{followUp.note}</p>
                ) : null}

                <div className="follow-up-actions">
                  <a
                    className="send-whatsapp"
                    href={whatsappHref(followUp.patient_phone, messageFor(followUp))}
                    target="_blank"
                    rel="noreferrer"
                  >
                    WhatsApp
                  </a>
                  <a
                    className="send-sms"
                    href={smsHref(followUp.patient_phone, messageFor(followUp))}
                  >
                    SMS
                  </a>
                </div>

                <div className="follow-up-actions">
                  <button
                    type="button"
                    className="restore-button"
                    disabled={Boolean(pendingId)}
                    onClick={() => handleUpdate(followUp, 'done')}
                  >
                    Came Back
                  </button>
                  <button
                    type="button"
                    className="no-show-button"
                    disabled={Boolean(pendingId)}
                    onClick={() => handleUpdate(followUp, 'cancel')}
                  >
                    Cancel
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}

export default FollowUpsPage
