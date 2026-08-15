import pino from 'pino';

/**
 * Structured logger. The trigger engine logs every state change it makes, which
 * is the audit trail for "why did my order fire at that price".
 */
export const logger = pino({
  name: 'soe-worker',
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['*.privateKey', '*.EXECUTOR_PRIVATE_KEY', '*.DATABASE_URL', '*.REDIS_URL'],
    censor: '[redacted]',
  },
});

/** Structural type, so the engine can take a logger without importing pino. */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
