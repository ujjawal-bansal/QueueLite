import { Component } from 'react'

/**
 * The last line before a blank screen.
 *
 * Without this, one bad value from the API takes the whole app down to white
 * and the front desk has a queue in front of them and nothing on the screen.
 * A reload usually clears it, so that is what this offers, along with the
 * error itself so the problem can actually be reported.
 *
 * Class component because that is still the only way to catch a render error
 * in React; there is no hook equivalent.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Nothing collects these yet, but the console is where anyone looking at a
    // broken desk will start.
    console.error('QueueLite render error:', error, info?.componentStack)
  }

  render() {
    const { error } = this.state

    if (!error) {
      return this.props.children
    }

    return (
      <main className="login-page">
        <div className="login-card">
          <h1>Something broke on this screen</h1>
          <p>
            The queue itself is unaffected: nothing has been lost, and reloading
            usually clears this.
          </p>

          <button
            type="button"
            className="primary-button"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>

          <p className="error-detail">{error.message || String(error)}</p>
        </div>
      </main>
    )
  }
}

export default ErrorBoundary
