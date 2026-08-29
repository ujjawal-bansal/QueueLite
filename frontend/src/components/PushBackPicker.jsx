// A patient who missed their turn and came back is slotted in a couple of
// places down, not sent to the end of the day. These are the numbers a desk
// actually says out loud.
const PUSH_BACK_CHOICES = [1, 2, 3, 5]

/**
 * "Put them back after how many patients?"
 *
 * Shown in place of the row's usual action, so the choice is made where the
 * patient is rather than in a dialog that hides the queue behind it.
 */
function PushBackPicker({ token, disabled, onChoose, onCancel }) {
  return (
    <div className="push-back-picker" role="group" aria-label="Put back after how many patients">
      <span>After</span>
      {PUSH_BACK_CHOICES.map((places) => (
        <button
          key={places}
          type="button"
          className="push-back-choice"
          disabled={disabled}
          onClick={() => onChoose(token, places)}
        >
          {places}
        </button>
      ))}
      <button
        type="button"
        className="push-back-cancel"
        aria-label="Cancel"
        onClick={onCancel}
      >
        ✕
      </button>
    </div>
  )
}

export default PushBackPicker
