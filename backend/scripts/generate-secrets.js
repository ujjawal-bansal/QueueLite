const crypto = require('crypto');

console.log('\nAdd these to backend/.env (and to Render\'s environment):\n');
console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`);
console.log(`WHATSAPP_VERIFY_TOKEN=${crypto.randomBytes(16).toString('hex')}`);
console.log('');
