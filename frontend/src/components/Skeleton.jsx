/**
 * Placeholder rows shown while the first load is in flight.
 *
 * Worth more here than in most apps: the free tier sleeps, so the first request
 * of the morning can take the better part of a minute. A shape that matches
 * what is coming reads as loading; the word "Loading..." reads as stuck.
 */
function Skeleton({ rows = 3, className = '' }) {
  return (
    <div className={`skeleton-list ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: rows }, (unused, index) => (
        <div key={index} className="skeleton-row">
          <span className="skeleton skeleton-number" />
          <span className="skeleton skeleton-line" />
        </div>
      ))}
    </div>
  )
}

export default Skeleton
