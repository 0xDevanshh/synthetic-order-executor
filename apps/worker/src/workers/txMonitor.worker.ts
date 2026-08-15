/**
 * tx-monitor (concurrency 5)
 *
 * Resolves a submitted transaction to a terminal state:
 *
 *   receipt.status == 1 and an OrderExecuted log present -> EXECUTED
 *   receipt.status == 0                                  -> FAILED, revert
 *                                                           decoded from the
 *                                                           contract's custom
 *                                                           errors
 *   no receipt within the window                         -> consult
 *                                                           consumedOrders
 *                                                           before deciding
 *
 * A dropped transaction is NEVER marked FAILED without reading
 * consumedOrders[orderHash] on-chain. A transaction can be slow rather than
 * dead, and assuming otherwise is how you double-execute.
 *
 * Stuck transactions past STUCK_TX_SEC are replaced at the SAME nonce with
 * +12.5% fees. That is a replacement, not a second order; both hashes are
 * tracked and the loser becomes REPLACED.
 */

// TODO(impl)
export {};
