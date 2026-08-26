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
const RETRY_DELAYS_MS = [1000, 3000, 6000]

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Lets the UI say "reconnecting" instead of appearing frozen while a sleeping
// server wakes up.
const retryListeners = new Set()

export function onRetry(listener) {
  retryListeners.add(listener)
  return () => retryListeners.delete(listener)
}

const announceRetry = (isRetrying) => {
  retryListeners.forEach((listener) => listener(isRetrying))
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
      announceRetry(true)
      await wait(RETRY_DELAYS_MS[attempt])
      continue
    }

    if (lastError) {
      throw lastError
    }
  }

  announceRetry(false)

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

export function callIn(slug, tokenId) {
  return request(`/api/clinics/${slug}/tokens/${tokenId}/call-in`, {
    method: 'PATCH',
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

export function getTokenStatus(slug, tokenId) {
  return request(`/api/clinics/${slug}/tokens/${tokenId}`)
}
