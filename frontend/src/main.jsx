import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

// A page open since before the last deploy asks for the staff chunk by its old
// name, which the new deployment no longer serves. Reloading picks up the
// current build. Once only: if a fresh page cannot load it either, reloading
// again would loop, so the error boundary gets to explain instead.
const RELOADED_AT_KEY = 'ql_chunk_reload_at'

window.addEventListener('vite:preloadError', () => {
  try {
    const reloadedAt = Number(sessionStorage.getItem(RELOADED_AT_KEY))

    if (Date.now() - reloadedAt < 30000) {
      return
    }

    sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()))
  } catch {
    // No storage means no loop guard, so leave it to the error boundary.
    return
  }

  window.location.reload()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
