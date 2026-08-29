const env = require('../config/env');
const logger = require('../utils/logger');
const notifier = require('./notifier');
const {
  getQueueState,
  claimReminder,
  releaseReminder,
  waitingInOrder,
} = require('./queueService');

/**
 * Who is due a reminder right now.
 *
 * On a ten-patient morning the person at the door can see the queue move. At a
 * hundred they cannot, and "you're next" arriving when they need to already be
 * in the room is no use to someone waiting at home. So there are two rungs:
 *
 *   heads_up   - inside the lead window, "start heading over"
 *   your_turn  - nothing left ahead of them, "you're next"
 *
 * Both are keyed to position rather than to a particular staff action, so a
 * no-show, an undo, or three patients called in quickly all produce the right
 * messages without any of those paths knowing about reminders.
 */
const findDueReminders = (tokens, { leadPatients = env.reminderLeadPatients } = {}) => {
  // Queue order, not token order: a patient pushed back to sixth place must be
  // reminded when they reach the front, not when their number comes up.
  const waiting = waitingInOrder(tokens);

  const due = [];

  waiting.forEach((token, index) => {
    // index is exactly how many waiting patients sit in front of this one.
    if (index === 0) {
      if (!token.turn_notified_at) {
        due.push({ token, kind: 'your_turn', ahead: 0 });
      }

      return;
    }

    if (leadPatients > 0 && index <= leadPatients && !token.heads_up_sent_at) {
      due.push({ token, kind: 'heads_up', ahead: index });
    }
  });

  return due;
};

const deliver = (clinic, { token, kind, ahead }, currentTokenNumber) => {
  if (kind === 'your_turn') {
    return notifier.notifyYourTurn({
      phone: token.patient_phone,
      clinicName: clinic.name,
      tokenNumber: token.token_number,
      currentTokenNumber,
    });
  }

  return notifier.notifyHeadsUp({
    phone: token.patient_phone,
    clinicName: clinic.name,
    tokenNumber: token.token_number,
    ahead,
  });
};

const send = async (clinic, item, currentTokenNumber) => {
  const { token, kind } = item;

  // Claim before sending. The message is the side effect that cannot be taken
  // back, so losing the race must mean sending nothing rather than twice.
  const claimed = await claimReminder(token.id, kind);

  if (!claimed) {
    return false;
  }

  if (kind === 'your_turn') {
    // Someone who is next will never need the earlier nudge; claiming it too
    // stops a restore-then-recall from doubling back and sending one.
    await claimReminder(token.id, 'heads_up');
  }

  const delivered = await deliver(clinic, item, currentTokenNumber);

  if (!delivered) {
    // Hand the claim back so the next queue movement tries again. A WhatsApp
    // outage would otherwise cost this patient the only message they get, and
    // for someone who went home to wait that means missing their turn
    // outright. The cost of being wrong the other way - a message that did
    // land being sent twice - is one duplicate notification.
    await releaseReminder(token.id, kind);
    logger.warn(
      { tokenNumber: token.token_number, kind },
      'reminder send failed, will retry on the next queue change'
    );
  }

  return delivered;
};

/**
 * Brings reminders up to date with the queue as it now stands.
 *
 * Reads fresh: it runs straight after a mutation, and acting on a snapshot
 * taken before that mutation would message the wrong patient.
 */
const runReminders = async (clinic) => {
  const state = await getQueueState(clinic, { fresh: true });

  // Drop what the channel cannot carry before claiming any of it. Claiming a
  // heads-up with no approved template would mark the patient as reminded, and
  // show "Reminded" at the desk, for a WhatsApp that was never sent.
  const due = findDueReminders(state.tokens).filter(
    (item) => item.kind !== 'heads_up' || notifier.canSendHeadsUp
  );

  if (due.length === 0) {
    return { sent: 0, due: 0 };
  }

  const results = await Promise.all(
    due.map((item) => send(clinic, item, state.current_token_number))
  );

  const sent = results.filter(Boolean).length;

  logger.info(
    { due: due.length, sent, kinds: due.map((item) => item.kind) },
    'queue reminders processed'
  );

  return { sent, due: due.length };
};

/**
 * Same, but never on the request's critical path.
 *
 * A WhatsApp send takes a few hundred milliseconds and can hang. Awaiting up to
 * four of them would put that delay on every Call In tap, which at a busy desk
 * is the difference between the button feeling instant and feeling broken.
 */
const runRemindersInBackground = (clinic) => {
  setImmediate(() => {
    runReminders(clinic).catch((error) => {
      logger.error({ err: { message: error.message } }, 'reminder pass failed');
    });
  });
};

module.exports = { findDueReminders, runReminders, runRemindersInBackground };
