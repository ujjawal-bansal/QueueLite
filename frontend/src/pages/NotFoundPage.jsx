import { Link } from 'react-router-dom'

function NotFoundPage() {
  return (
    <main className="not-found-page">
      <h1>Page not found</h1>
      <p className="empty-state">
        That link does not match a clinic queue or a patient token.
      </p>
      <Link className="primary-button" to="/">
        Go Home
      </Link>
    </main>
  )
}

export default NotFoundPage
