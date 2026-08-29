/**
 * The clinic's mark, from the logo above the door: two nested chevrons opening
 * to the right, closed by a solid lens. Together they read as an eye seen from
 * the side, which is the whole idea.
 *
 * Inline SVG rather than an image file so it stays sharp at any size, takes its
 * colours from the stylesheet, and costs no extra request on a phone waiting
 * for a free-tier server to wake.
 *
 * The artwork is wider than it is tall, so `size` sets the height and the width
 * follows; passing both would squash it.
 */
const RATIO = 100 / 88

function ClinicMark({ size = 34, className = '' }) {
  return (
    <svg
      className={`clinic-mark ${className}`.trim()}
      width={Math.round(size * RATIO)}
      height={size}
      viewBox="0 0 100 88"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M68.5 2 15 45.3 68.5 85.5"
        stroke="var(--mark-grey)"
        strokeWidth="3"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path
        d="M71 11 26 45.3 72 76.5"
        stroke="var(--mark-grey)"
        strokeWidth="3"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      {/* The lens: a flat-ish inner edge against the chevrons, bulging out to
          the right, pointed where the two meet. */}
      <path
        d="M68 13.5C79 24 85.5 34 85.5 45.5S79 67 70 76.5C66 66 65 56 65.5 45.5S66.5 23 68 13.5Z"
        fill="var(--mark-blue)"
      />
    </svg>
  )
}

/**
 * The clinic's name set the way the sign sets it, with the middle word in the
 * lighter blue. Falls back to plain text for any name that is not built around
 * "eye", so a different clinic in this codebase still reads correctly.
 */
export function ClinicWordmark({ name }) {
  const words = String(name || '').trim().split(/\s+/)
  const eyeIndex = words.findIndex((word) => word.toLowerCase() === 'eye')

  if (eyeIndex === -1) {
    return <>{name}</>
  }

  return (
    <>
      {words.map((word, index) => (
        <span key={`${word}-${index}`}>
          {index > 0 ? ' ' : ''}
          {index === eyeIndex ? <em className="wordmark-accent">{word}</em> : word}
        </span>
      ))}
    </>
  )
}

export default ClinicMark
