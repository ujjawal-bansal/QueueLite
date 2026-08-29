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

const allowedOrigins = new Set(
  [env.frontendUrl, ...env.extraAllowedOrigins].filter(Boolean)
);

app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header at all: curl, health checks, Meta's webhook.
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }

      // The browser only tells the user "failed to fetch", so record the real
      // reason here - otherwise a blocked origin is invisible to diagnose.
      logger.warn({ origin, allowed: [...allowedOrigins] }, 'blocked cross-origin request');
      return callback(null, false);
    },
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

// The API has no UI. Answer the bare root with something self-explanatory so
// visiting the service URL does not look like a broken deploy.
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'queuelite-api',
    message: 'QueueLite API. The app itself lives at the frontend URL below.',
    data: {
      app: env.frontendUrl,
      health: '/api/health',
    },
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.use(errorHandler);

// Only bind a port when run as the service. Requiring this file to drive the
// app in a test must not leave a listener behind.
if (require.main === module) {
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
}

module.exports = app;
