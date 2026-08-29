import { useState } from 'react'

// The intervals an eye clinic actually uses: a post-op check, a fortnight
// review, a month, a quarterly. Anything else is typed.
const QUICK_DAYS = [7, 15, 30, 90]

/**
 * Offered the moment a visit is marked done.
 *
 * This is the only moment the instruction exists: the doctor has just said
 * "come back in fifteen days", the patient is still at the desk, and nobody is
 * going to open a separate screen later to record it.
 */
function FollowUpPrompt({ token, isSaving, error, onSave, onSkip }) {
  const [days, setDays] = useState(null)
  const [customDays, setCustomDays] = useState('')
  const [note, setNote] = useState('')

  const chosen = days ?? (customDays ? Number(customDays) : null)
  const canSave = Number.isInteger(chosen) && chosen >= 1 && chosen <= 365

  return (
    <section className="follow-up-prompt">
      <div className="follow-up-prompt-head">
        <div>
          <p>Follow-up for #{token.token_number}</p>
          <strong>{token.patient_name}</strong>
        </div>
        <button type="button" className="dismiss-button" onClick={onSkip}>
          Skip
        </button>
      </div>

      <div className="follow-up-days" role="group" aria-label="Come back after">
        <span>After</span>
        {QUICK_DAYS.map((value) => (
          <button
            key={value}
            type="button"
            className={
              days === value
                ? 'push-back-choice push-back-choice-active'
                : 'push-back-choice'
            }
            aria-pressed={days === value}
            onClick={() => {
              setDays(value)
              setCustomDays('')
            }}
          >
            {value}d
          </button>
        ))}
        <input
          type="text"
          inputMode="numeric"
          className="follow-up-custom"
          value={customDays}
          placeholder="other"
          aria-label="Other number of days"
          onChange={(event) => {
            setCustomDays(event.target.value.replace(/\D/g, '').slice(0, 3))
            setDays(null)
          }}
        />
      </div>

      <label className="follow-up-note-field">
        <span>Doctor&apos;s note (optional)</span>
        <input
          type="text"
          value={note}
          maxLength={500}
          placeholder="e.g. bring old glasses, check pressure"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      {error ? <p className="form-error">{error}</p> : null}

      <button
        type="button"
        className="primary-button"
        disabled={!canSave || isSaving}
        onClick={() => onSave(token, chosen, note.trim())}
      >
        {isSaving ? 'Saving...' : `Schedule follow-up${canSave ? ` in ${chosen} days` : ''}`}
      </button>
    </section>
  )
}

export default FollowUpPrompt
