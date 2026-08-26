const env = require('../config/env');
const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;

  logger.error(
    { err: { message: err.message, stack: err.stack }, path: req.path },
    'request failed'
  );

  // Internal failures must not leak stack traces or driver messages to callers.
  const message =
    statusCode >= 500 && env.isProduction
      ? 'Something went wrong. Please try again.'
      : err.message || 'Internal server error';

  res.status(statusCode).json({ success: false, error: message });
};

module.exports = errorHandler;
