/**
 * Builds ExecutionParams and submits executeOrder. The single point where
 * calldata is constructed and a transaction is signed.
 *
 * The slippage rule lives here and is unit-tested at the boundary:
 *
 *   runtimeMinOut = max(quote * (10_000 - EXECUTION_SLIPPAGE_BPS) / 10_000,
 *                       order.minAmountOut)
 *
 * The max() is not defensive styling — the contract rejects anything below the
 * signed floor, so getting this wrong turns into an on-chain revert.
 */

// TODO(impl)
export {};
