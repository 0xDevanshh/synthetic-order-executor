/**
 * reconciler (repeatable, 60s)
 *
 * The chain is authoritative; the database is a cache that can be wrong.
 *
 *   A. Stuck EXECUTING (>5 min): read consumedOrders[orderHash].
 *        true  -> find the OrderExecuted log, backfill amountOut/block/gas,
 *                 set EXECUTED
 *        false -> and nothing pending in the mempool -> FAILED (retryable)
 *
 *   B. Log backfill: scan OrderExecuted from IndexerCheckpoint, re-scanning the
 *      last REORG_BUFFER_BLOCKS every pass and upserting idempotently on
 *      orderHash. Catches executions the backend never recorded.
 *
 *   C. Balance invariant, per allowlisted token:
 *        IERC20.balanceOf(contract) >= totalAccounted[token]
 *      A violation is a P0: log it, alert, and pause() if
 *      AUTO_PAUSE_ON_INVARIANT_BREACH is set.
 *
 *   D. Orphans: an EXECUTED order with no matching on-chain log goes back to
 *      EXECUTING for re-resolution.
 *
 *   E. Expiry sweep: PENDING / TRIGGERED past expiry -> CANCELLED.
 *
 * Every repair writes a ReconciliationLog row. Silent self-healing destroys the
 * ability to debug.
 */

// TODO(impl)
export {};
