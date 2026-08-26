const crypto = require('crypto');
const readline = require('readline');

const KEY_LENGTH = 64;

const hash = (passcode) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${derived}`;
};

const passcode = process.argv[2];

if (passcode) {
  console.log(`\nSTAFF_PASSCODE_HASH=${hash(passcode)}\n`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Choose a staff passcode: ', (answer) => {
  if (!answer || answer.length < 6) {
    console.error('\nUse at least 6 characters.\n');
    process.exit(1);
  }

  console.log(`\nSTAFF_PASSCODE_HASH=${hash(answer)}\n`);
  rl.close();
});
