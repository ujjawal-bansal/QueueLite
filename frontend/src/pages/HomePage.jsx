import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getClinic } from '../api/queue'

function formatHours(opensAt, closesAt) {
  if (!opensAt || !closesAt) {
    return ''
  }

  // Postgres hands back "10:00:00"; a patient wants "10:00 am".
  const toLabel = (value) => {
    const [hour, minute] = value.split(':').map(Number)
    const suffix = hour >= 12 ? 'pm' : 'am'
    const displayHour = hour % 12 === 0 ? 12 : hour % 12

    return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`
  }

  return `${toLabel(opensAt)} - ${toLabel(closesAt)}`
}

function HomePage() {
  const mountedRef = useRef(false)
  const [clinic, setClinic] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    mountedRef.current = true

    getClinic()
      .then((data) => {
        if (mountedRef.current) {
          setClinic(data)
          setLoadError('')
        }
      })
      .catch((error) => {
        if (mountedRef.current) {
          setLoadError(error.message)
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setIsLoading(false)
        }
      })

    return () => {
      mountedRef.current = false
    }
  }, [])

  const hours = formatHours(clinic?.opens_at, clinic?.closes_at)

  return (
    <main className="home-page">
      <header className="clinic-header">
        <div>
          <h1>{clinic?.name || 'QueueLite'}</h1>
          <p>{clinic?.doctor_name || 'Walk-in token queue'}</p>
        </div>
      </header>

      <section className="clinic-list">
        {isLoading ? <p className="empty-state">Loading...</p> : null}
        {loadError ? <p className="error-banner">{loadError}</p> : null}

        {clinic ? (
          <>
            <h2>Front Desk</h2>
            <p className="empty-state">
              Staff sign in here to issue tokens and run the queue.
            </p>
            <Link className="primary-button" to={`/staff/${clinic.slug}`}>
              Open Staff Dashboard
            </Link>

            <h2 className="home-second-heading">Waiting Room</h2>
            <p className="empty-state">
              A public board showing the number being seen. Patients can look up
              their own token on it.
            </p>
            <Link className="secondary-button" to={`/board/${clinic.slug}`}>
              Open Queue Board
            </Link>
          </>
        ) : null}
      </section>

      {clinic?.address || hours ? (
        <section className="clinic-contact">
          {clinic.address ? <p className="clinic-address">{clinic.address}</p> : null}
          {hours ? <p className="clinic-hours">Open {hours}</p> : null}
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

      <p className="patient-footer">
        Patients track their turn from the link they receive on WhatsApp.
      </p>
    </main>
  )
}

export default HomePage
