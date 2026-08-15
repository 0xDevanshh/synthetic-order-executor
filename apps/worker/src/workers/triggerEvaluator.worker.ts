/**
 * trigger-evaluator (repeatable, 10s) — NOT YET IMPLEMENTED.
 *
 * The "WHEN" half of the system, and the only place the trigger condition is
 * decided. Moves PENDING -> TRIGGERED via OrderService.markTriggered and
 * enqueues execute-order with jobId = orderId.
 *
 * It does not quote and does not touch the wallet. Keeping evaluation free of
 * side effects is what makes it safe to run on a tight interval.
 */
export {};
