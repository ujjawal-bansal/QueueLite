import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getClinic } from '../api/queue'

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
          </>
        ) : null}
      </section>

      <p className="patient-footer">
        Patients track their turn from the link they receive on WhatsApp.
      </p>
    </main>
  )
}

export default HomePage
