const pino = require('pino');
const env = require('../config/env');

// Patient names and phone numbers must never reach the logs.
const redact = {
  paths: [
    'req.headers.cookie',
    'req.headers.authorization',
    'req.body.patient_name',
    'req.body.patient_phone',
    'req.body.passcode',
    'patient_name',
    'patient_phone',
    '*.patient_name',
    '*.patient_phone',
  ],
  censor: '[redacted]',
};

const logger = pino({
  level: env.isProduction ? 'info' : 'debug',
  redact,
  transport: env.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

module.exports = logger;
