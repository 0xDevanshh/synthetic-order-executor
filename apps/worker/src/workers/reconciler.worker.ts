/**
 * reconciler (repeatable, 60s) — NOT YET IMPLEMENTED.
 *
 * The chain is authoritative; the database is a cache that can be wrong.
 * Resolves stuck EXECUTING orders against `isExecuted(executionId)`, backfills
 * from SwapExecuted logs, and checks the balance invariant
 * `balanceOf(contract) >= totalAccounted[token]`.
 */
export {};
