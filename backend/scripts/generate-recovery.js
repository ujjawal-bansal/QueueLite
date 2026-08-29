const crypto = require('crypto');

const KEY_LENGTH = 64;

/**
 * A break-glass code for the one morning the front desk cannot remember the
 * passcode and the clinic is already full.
 *
 * Generated rather than chosen: this is not typed daily, so it should be long
 * and random, and nobody should have to invent it. Only the hash goes into the
 * environment - the code itself is printed once, here, and never stored.
 */
const code = crypto.randomBytes(15).toString('base64url');
const salt = crypto.randomBytes(16).toString('hex');
const derived = crypto.scryptSync(code, salt, KEY_LENGTH).toString('hex');

console.log(`
================================================================
  1. THE RECOVERY CODE - keep this, do NOT put it in .env
================================================================

     ${code}

  Print it and keep it where the front desk can reach it. It is
  not stored anywhere and cannot be recovered if lost.

================================================================
  2. THE HASH - copy this whole line into .env and Render
================================================================

STAFF_RECOVERY_CODE_HASH=scrypt$${salt}$${derived}

  The two are different on purpose: the server only ever stores
  the hash, so a leaked .env does not hand anyone the code.

  Restart the backend afterwards - a .env change is not picked
  up by \`npm run dev\` on its own.
`);
