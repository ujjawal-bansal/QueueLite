const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

async function request(path, options = {}) {
  if (!API_BASE_URL) {
    throw new Error('API base URL is missing')
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  })

  let result

  try {
    result = await response.json()
  } catch {
    throw new Error('Could not read server response')
  }

  if (!response.ok || result.success === false) {
    throw new Error(result.error || 'Request failed')
  }

  return result.data
}

async function getClinic(slug) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/clinics?slug=eq.${encodeURIComponent(
      slug,
    )}&select=id,name,slug,doctor_name`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  )

  if (!response.ok) {
    return null
  }

  const clinics = await response.json()
  return clinics[0] || null
}

export async function getQueueToday(slug) {
  const [queue, clinic] = await Promise.all([
    request(`/api/clinics/${slug}/queue/today`),
    getClinic(slug),
  ])

  return {
    ...queue,
    clinic,
  }
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

export function markNoShow(slug, tokenId) {
  return request(`/api/clinics/${slug}/tokens/${tokenId}/no-show`, {
    method: 'PATCH',
  })
}
