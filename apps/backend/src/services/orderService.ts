/**
 * Order use-cases: prepare, create, list, get, cancel.
 *
 * Creation path:
 *   1. Validate tokens against the on-chain allowlist and max trade size —
 *      reject at the API rather than letting the user sign an order the
 *      contract would refuse.
 *   2. Derive minAmountOut from the trigger price. This is the user's hard
 *      floor; the executor can only tighten it later.
 *   3. Recompute the orderHash server-side and verify the signature.
 *   4. Insert with status PENDING. The unique constraint on orderHash makes
 *      resubmission idempotent.
 */

// TODO(impl)
export {};
