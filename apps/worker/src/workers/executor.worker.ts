/**
 * execute-order (concurrency 1)
 *
 * The only writer of on-chain state. Sequence:
 *
 *   1. Atomic claim: TRIGGERED -> EXECUTING via conditional UPDATE. Zero rows
 *      means another worker won — exit silently.
 *   2. Pre-flight reads: order not expired, consumedOrders[orderHash] == false,
 *      vault balance sufficient, tokens still allowlisted, contract not paused.
 *      Any failure fails the order BEFORE anything is signed.
 *   3. Fresh quote from the DexAdapter.
 *   4. runtimeMinOut = max(quote * (1 - EXECUTION_SLIPPAGE_BPS), signedFloor).
 *      If the quote cannot even reach the signed floor, do NOT send: return the
 *      order to TRIGGERED and wait for a better tick. That is an expected
 *      market condition, not an error.
 *   5. deadline = now + DEADLINE_WINDOW_SEC, within the contract's window.
 *   6. simulateContract first — catches every revert for free and lets us
 *      classify the failure without burning gas.
 *   7. Allocate the EOA nonce under the Redis mutex; cap fees at
 *      MAX_FEE_PER_GAS_GWEI.
 *   8. Persist the ExecutionAttempt WITH the tx hash BEFORE broadcasting. A
 *      locally signed raw tx has a known hash, so a sent transaction can never
 *      go unrecorded. This ordering is what makes reconciliation converge.
 *   9. Broadcast, then enqueue tx-monitor.
 *
 * Never mark an order FAILED because of a send error alone — a send error does
 * not prove the transaction was not broadcast.
 */

// TODO(impl)
export {};
