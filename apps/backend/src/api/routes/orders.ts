/**
 * Order routes.
 *
 *   POST   /api/v1/orders/prepare      -> EIP-712 payload + assigned nonce to sign
 *   POST   /api/v1/orders              -> submit { intent, trigger, signature }
 *   GET    /api/v1/orders              -> list caller's orders (cursor paginated)
 *   GET    /api/v1/orders/:id          -> order + attempts + tx hashes
 *   POST   /api/v1/orders/:id/cancel   -> off-chain cancel (PENDING | TRIGGERED)
 *   GET    /api/v1/orders/:id/events   -> SSE status stream
 *
 * POST /orders is idempotent on orderHash: resubmitting returns 200 with the
 * existing order rather than 409, so a flaky frontend retry is harmless.
 *
 * The server independently recomputes the orderHash and verifies the signature
 * before storing. It never trusts a client-supplied hash.
 */

// TODO(impl): express Router with zod-validated handlers.
export {};
