/**
 * Pino logger. Redaction list must cover every secret-bearing key
 * (privateKey, signature, authorization, DATABASE_URL) — an execution engine
 * logs a lot, and one careless log line leaks the hot wallet.
 */

// TODO(impl)
export {};
