import { useCallback, useEffect, useRef, useState } from 'react'
import { getSession, login } from '../api/queue'

/**
 * Gates the staff dashboard. The session itself lives in an httpOnly cookie the
 * page cannot read, so the only way to know whether we are signed in is to ask.
 */
function RequireStaff({ children }) {
  const mountedRef = useRef(false)
  const [state, setState] = useState('checking')
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const check = useCallback(async () => {
    try {
      await getSession()

      if (mountedRef.current) {
        setState('signed-in')
      }
    } catch {
      if (mountedRef.current) {
        setState('signed-out')
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const checkId = window.setTimeout(check, 0)

    return () => {
      mountedRef.current = false
      window.clearTimeout(checkId)
    }
  }, [check])

  async function handleSubmit(event) {
    event.preventDefault()

    if (!passcode.trim()) {
      setError('Enter the clinic passcode')
      return
    }

    setIsSubmitting(true)
    setError('')

    try {
      await login(passcode)

      if (mountedRef.current) {
        setPasscode('')
        setState('signed-in')
      }
    } catch (loginError) {
      if (mountedRef.current) {
        setError(loginError.message)
      }
    } finally {
      if (mountedRef.current) {
        setIsSubmitting(false)
      }
    }
  }

  if (state === 'checking') {
    return (
      <main className="login-page">
        <p className="empty-state">Checking your session...</p>
      </main>
    )
  }

  if (state === 'signed-in') {
    return children
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <h1>QueueLite</h1>
        <p>Enter the clinic passcode to open the front desk.</p>

        <form onSubmit={handleSubmit} noValidate>
          <label>
            <span>Passcode</span>
            <input
              type="password"
              value={passcode}
              onChange={(event) => {
                setPasscode(event.target.value)
                setError('')
              }}
              autoComplete="current-password"
              autoFocus
              aria-invalid={Boolean(error)}
            />
          </label>

          {error ? <p className="form-error">{error}</p> : null}

          <button type="submit" className="primary-button" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  )
}

export default RequireStaff
