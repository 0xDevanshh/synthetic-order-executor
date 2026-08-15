/**
 * Maps an RPC error or a decoded contract revert to a FailureClass, which
 * decides whether the order may retry.
 *
 *   OrderAlreadyConsumed        -> ALREADY_CONSUMED   (reconcile to EXECUTED)
 *   SlippageExceeded            -> MARKET_CONDITIONS  (retry on a later tick)
 *   MinOutBelowSignedFloor,
 *   NotAllowedToken,
 *   TradeTooLarge, BadSignature -> CONTRACT_REJECTED  (never retry)
 *   timeout / underpriced /
 *   nonce too low               -> TRANSIENT          (retry)
 *   anything else               -> UNKNOWN            (do not retry, surface it)
 *
 * Blind retries against a live execution engine are how testnet bugs become
 * mainnet incidents, so the default for an unrecognised error is: do not retry.
 */

// TODO(impl)
export {};
