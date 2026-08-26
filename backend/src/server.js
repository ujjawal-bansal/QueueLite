const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');

const env = require('./config/env');
const logger = require('./utils/logger');
const clinicRoutes = require('./routes/clinics');
const authRoutes = require('./routes/auth');
const whatsappRoutes = require('./routes/whatsapp');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Render terminates TLS upstream; without this req.ip is the proxy and the
// rate limiters would bucket every visitor together.
app.set('trust proxy', 1);

app.use(helmet());

app.use(
  cors({
    origin: env.frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  })
);

app.use(
  express.json({
    limit: '100kb',
    // Meta signs the exact bytes it sent, so keep them for verification.
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(cookieParser());

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/api/health',
    },
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api', clinicRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.use(errorHandler);

const server = app.listen(env.port, () => {
  logger.info(
    { port: env.port, clinic: env.clinicSlug, notifier: env.notifier, env: env.nodeEnv },
    'QueueLite backend started'
  );
});

// Let in-flight requests finish before the process goes away on redeploy.
const shutdown = (signal) => () => {
  logger.info({ signal }, 'shutting down');

  server.close(() => {
    logger.info('closed cleanly');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: { message: String(reason) } }, 'unhandled rejection');
});

module.exports = app;
