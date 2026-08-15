import pino from 'pino';

/**
 * Application logger.
 *
 * The redaction list is not decorative: an execution engine logs a great deal,
 * and one careless log line is how a hot wallet key or a Neon connection string
 * ends up in a log aggregator.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.privateKey',
      '*.PRIVATE_KEY',
      '*.DEPLOYER_PRIVATE_KEY',
      '*.EXECUTOR_PRIVATE_KEY',
      '*.DATABASE_URL',
      '*.signature',
    ],
    censor: '[redacted]',
  },
  ...(process.env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
