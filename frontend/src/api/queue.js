// Unset means misconfigured; an explicit empty value means "same origin",
// which is how the dev server (and any single-origin deploy) talks to the API.
const RAW_API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const API_BASE_URL =
  RAW_API_BASE_URL === undefined ? null : RAW_API_BASE_URL.replace(/\/+$/, '')

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// A sleeping free-tier server drops the first request while it wakes, which at
// a clinic desk looks like the app is broken. Retry the safe-to-repeat calls
// instead of surfacing that. POST is never retried: re-sending a token
// creation that actually succeeded would issue the patient a second number.
const RETRYABLE_METHODS = new Set(['GET', 'PATCH'])
// A free-tier instance takes 30-60s to come back from a redeploy or a sleep,
// so a 10s window gave up while the server was still on its way. Cover a
// realistic restart instead of making staff re-tap and wonder what broke.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 12000, 15000, 15000]

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Lets the UI say "reconnecting" instead of appearing frozen while a sleeping
// server wakes up.
const retryListeners = new Set()

export function onRetry(listener) {
  retryListeners.add(listener)
  return () => retryListeners.delete(listener)
}

const announceRetry = (state) => {
  retryListeners.forEach((listener) => listener(state))
}

async function request(path, options = {}) {
  if (API_BASE_URL === null) {
    throw new ApiError('VITE_API_BASE_URL is not set', 0)
  }

  const method = (options.method || 'GET').toUpperCase()
  const canRetry = RETRYABLE_METHODS.has(method)
  const attempts = canRetry ? RETRY_DELAYS_MS.length + 1 : 1

  let response
  let lastError

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        // The staff session is an httpOnly cookie, so it has to ride along.
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        ...options,
      })
      lastError = null
    } catch {
      lastError = new ApiError('Cannot reach the server. Check your connection.', 0)
    }

    // 502/503/504 are what a platform returns while the instance is starting.
    const isWaking = response && [502, 503, 504].includes(response.status)

    if (!lastError && !isWaking) {
      break
    }

    if (attempt < attempts - 1) {
      announceRetry({ retrying: true, attempt: attempt + 1, total: attempts - 1 })
      await wait(RETRY_DELAYS_MS[attempt])
      continue
    }

    if (lastError) {
      throw lastError
    }
  }

  announceRetry({ retrying: false, attempt: 0, total: 0 })

  if (lastError) {
    throw lastError
  }

  let result

  try {
    result = await response.json()
  } catch {
    throw new ApiError('Could not read server response', response.status)
  }

  if (!response.ok || result.success === false) {
    throw new ApiError(result.error || 'Request failed', response.status)
  }

  return result.data
}

export function login(passcode) {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ passcode }),
  })
}

// Break-glass sign-in. 404 means no recovery code is configured for this
// deployment, which the login screen shows as instructions instead of a form.
export function recoverAccess(code) {
  return request('/api/auth/recover', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export function logout() {
  return request('/api/auth/logout', { method: 'POST' })
}

export function getSession() {
  return request('/api/auth/session')
}

export function getClinic() {
  return request('/api/clinic')
}

export function getQueueToday(slug) {
  return request(`/api/clinics/${slug}/queue/today`)
}

export function addPatient(slug, patientName, patientPhone) {
  return request(`/api/clinics/${slug}/tokens`, {
    method: 'POST',
    body: JSON.stringify({
      patient_name: patientName,
      patient_phone: patientPhone,
    }),
  })
}

// Calls in whoever is at the front. The desk has no per-patient call button:
// patients are seen in queue order, so there is one control, not one per row.
// Not retried: it is a POST, and a repeat would call in two patients.
export function callNext(slug) {
  return request(`/api/clinics/${slug}/call-next`, { method: 'POST' })
}

// Puts a patient back in the queue with `places` more patients ahead of them,
// counted from where they stand now.
export function pushBackToken(slug, tokenId, places) {
  return request(`/api/clinics/${slug}/tokens/${tokenId}/push-back`, {
    method: 'PATCH',
    body: JSON.stringify({ places }),
  })
}

export function completeToken(slug, tokenId) {
  return request(`/api/clinics/${slug}/tokens/${tokenId}/done`, {
    method: 'PATCH',
  })
}

export function restoreToken(slug, tokenId) {
  return request(`/api/clinics/${slug}/tokens/${tokenId}/restore`, {
    method: 'PATCH',
  })
}

export function markNoShow(slug, tokenId) {
  return request(`/api/clinics/${slug}/tokens/${tokenId}/no-show`, {
    method: 'PATCH',
  })
}

// Public waiting-room board. `tokenNumber` optionally asks "where is number 47",
// which is what a patient given only a number over the phone can look up.
export function getBoard(slug, tokenNumber) {
  const query = tokenNumber ? `?token=${encodeURIComponent(tokenNumber)}` : ''

  return request(`/api/clinics/${slug}/board${query}`)
}

export function getFollowUps(slug) {
  return request(`/api/clinics/${slug}/follow-ups`)
}

export function addFollowUp(slug, tokenId, days, note) {
  return request(`/api/clinics/${slug}/tokens/${tokenId}/follow-up`, {
    method: 'POST',
    body: JSON.stringify({ days, note }),
  })
}

export function completeFollowUp(slug, followUpId) {
  return request(`/api/clinics/${slug}/follow-ups/${followUpId}/done`, {
    method: 'PATCH',
  })
}

export function cancelFollowUp(slug, followUpId) {
  return request(`/api/clinics/${slug}/follow-ups/${followUpId}/cancel`, {
    method: 'PATCH',
  })
}

export function getTokenStatus(slug, tokenId) {
  return request(`/api/clinics/${slug}/tokens/${tokenId}`)
}
