/**
 * POST /api/v1/quotes -> { amountOut, poolFee, priceImpactBps }
 *
 * Preview only. The quote shown here never becomes a settlement guarantee: the
 * executor re-quotes immediately before submitting, and the user's signed
 * minAmountOut is what actually binds.
 */

// TODO(impl): router delegating to the DexAdapter, with a short cache and a
//             per-address rate limit (quoting hits the RPC).
export {};
