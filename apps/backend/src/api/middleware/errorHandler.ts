/**
 * Terminal error middleware.
 *
 * Maps domain errors to stable machine-readable codes:
 *   { error: { code, message, details } }
 *
 * e.g. ORDER_ALREADY_EXISTS, TOKEN_NOT_ALLOWED, TRADE_TOO_LARGE, PRICE_STALE,
 * INVALID_TRANSITION, INVALID_SIGNATURE.
 *
 * Internal details (stack traces, connection strings, RPC URLs) never reach the
 * response body.
 */

// TODO(impl)
export {};
