import { useEffect, useRef, useState } from 'react'

const GSI_SRC = 'https://accounts.google.com/gsi/client'

// Loaded once, and only when the login screen needs it: patients' pages never
// pull in Google's script.
let gsiLoading = null

function loadGoogleIdentity() {
  if (window.google?.accounts?.id) {
    return Promise.resolve(window.google.accounts.id)
  }

  if (!gsiLoading) {
    gsiLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = GSI_SRC
      script.async = true
      script.onload = () => resolve(window.google.accounts.id)
      script.onerror = () => {
        // Let a later attempt try again rather than caching the failure.
        gsiLoading = null
        reject(new Error('Could not load Google sign-in'))
      }
      document.head.appendChild(script)
    })
  }

  return gsiLoading
}

/**
 * Google's own "Sign in with Google" button.
 *
 * Drawn by Google rather than imitated, so it looks the way people expect and
 * the sign-in happens in Google's popup, never in a form on this page. All it
 * hands back is an ID token; the server decides whether that account is staff.
 */
function GoogleSignInButton({ clientId, onCredential, disabled = false }) {
  const containerRef = useRef(null)
  const onCredentialRef = useRef(onCredential)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    onCredentialRef.current = onCredential
  }, [onCredential])

  useEffect(() => {
    let cancelled = false

    loadGoogleIdentity()
      .then((identity) => {
        if (cancelled || !containerRef.current) {
          return
        }

        identity.initialize({
          client_id: clientId,
          callback: (response) => onCredentialRef.current(response.credential),
          // Nobody is signed in silently at a shared front-desk computer.
          auto_select: false,
          cancel_on_tap_outside: true,
        })

        identity.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          logo_alignment: 'center',
          width: Math.min(containerRef.current.offsetWidth || 320, 400),
        })
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error.message)
        }
      })

    return () => {
      cancelled = true
    }
  }, [clientId])

  if (loadError) {
    return <p className="form-error">{loadError}. Use the passcode instead.</p>
  }

  return (
    <div
      ref={containerRef}
      className={`google-signin${disabled ? ' is-busy' : ''}`}
      aria-busy={disabled}
    />
  )
}

export default GoogleSignInButton
