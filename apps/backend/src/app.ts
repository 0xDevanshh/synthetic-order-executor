/**
 * Express app assembly, kept separate from the listener so tests can mount it
 * with supertest without binding a port.
 *
 * Middleware order: helmet -> cors -> json -> request logging -> rate limit
 * -> routes -> errorHandler (last).
 */

// TODO(impl): createApp() returning the configured express instance.
export {};
