import { useCallback, useEffect, useRef, useState } from 'react'
import { getSession, login, recoverAccess } from '../api/queue'
import ClinicMark, { ClinicWordmark } from '../components/ClinicMark'

/**
 * Gates the staff dashboard. The session itself lives in an httpOnly cookie the
 * page cannot read, so the only way to know whether we are signed in is to ask.
 */
function RequireStaff({ children }) {
  const mountedRef = useRef(false)
  const [state, setState] = useState('checking')
  const [session, setSession] = useState(null)
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showRecovery, setShowRecovery] = useState(false)
  const [recoveryCode, setRecoveryCode] = useState('')
  const [recoveryError, setRecoveryError] = useState('')
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false)
  const [isRecovering, setIsRecovering] = useState(false)

  const check = useCallback(async () => {
    try {
      const data = await getSession()

      if (mountedRef.current) {
        setSession(data)
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

  async function handleRecover(event) {
    event.preventDefault()

    if (!recoveryCode.trim()) {
      setRecoveryError('Enter the recovery code')
      return
    }

    setIsRecovering(true)
    setRecoveryError('')

    try {
      const data = await recoverAccess(recoveryCode.trim())

      if (mountedRef.current) {
        setRecoveryCode('')
        setSession(data)
        setState('signed-in')
      }
    } catch (recoverError) {
      if (mountedRef.current) {
        // The route is absent, not forbidden, when no code is configured - so
        // show the manual reset steps rather than a form that cannot work.
        if (recoverError.status === 404) {
          setRecoveryUnavailable(true)
        } else {
          setRecoveryError(recoverError.message)
        }
      }
    } finally {
      if (mountedRef.current) {
        setIsRecovering(false)
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
    // Signed in on the break-glass code. Said on every page, every time, until
    // the passcode is actually reset - otherwise a clinic quietly runs on the
    // recovery code for months and nobody remembers it was temporary.
    if (session?.via === 'recovery') {
      return (
        <>
          <p className="recovery-banner" role="status">
            Signed in with the recovery code. Reset the staff passcode when the
            clinic quietens down.
          </p>
          {children}
        </>
      )
    }

    return children
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <ClinicMark size={52} className="login-mark" />
        <h1><ClinicWordmark name="Dev Eye Care" /></h1>
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

        {/* Forgetting the passcode used to be a dead end mid-clinic. */}
        {!showRecovery ? (
          <button
            type="button"
            className="link-button"
            onClick={() => setShowRecovery(true)}
          >
            Forgot the passcode?
          </button>
        ) : (
          <div className="recovery-panel">
            {recoveryUnavailable ? (
              <>
                <h2>No recovery code is set up</h2>
                <p>
                  Ask whoever manages the deployment to run{' '}
                  <code>npm run hash-passcode</code> in the backend, update{' '}
                  <code>STAFF_PASSCODE_HASH</code> on the server and redeploy.
                </p>
                <p>
                  To avoid this next time, they can run{' '}
                  <code>npm run generate-recovery</code> and keep the printed
                  code at the desk.
                </p>
              </>
            ) : (
              <>
                <h2>Use the recovery code</h2>
                <p>
                  The printed code kept at the desk. It signs you in once so the
                  clinic can keep running, but the passcode still needs resetting
                  afterwards.
                </p>

                <form onSubmit={handleRecover} noValidate>
                  <label>
                    <span>Recovery code</span>
                    <input
                      type="password"
                      value={recoveryCode}
                      onChange={(event) => {
                        setRecoveryCode(event.target.value)
                        setRecoveryError('')
                      }}
                      autoComplete="one-time-code"
                      aria-invalid={Boolean(recoveryError)}
                    />
                  </label>

                  {recoveryError ? (
                    <p className="form-error">{recoveryError}</p>
                  ) : null}

                  <button
                    type="submit"
                    className="secondary-button"
                    disabled={isRecovering}
                  >
                    {isRecovering ? 'Checking...' : 'Sign In With Recovery Code'}
                  </button>
                </form>
              </>
            )}

            <button
              type="button"
              className="link-button"
              onClick={() => setShowRecovery(false)}
            >
              Back to passcode
            </button>
          </div>
        )}
      </div>
    </main>
  )
}

export default RequireStaff
