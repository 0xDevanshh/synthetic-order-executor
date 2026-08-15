/**
 * trigger-evaluator (repeatable, 10s + pubsub-driven)
 *
 * The "WHEN" half of the system, and the only place the trigger condition is
 * ever decided.
 *
 *   1. Take the latest non-suspect tick for the pair.
 *   2. Select PENDING orders whose condition it satisfies (indexed on
 *      status, triggerType, triggerPrice).
 *   3. Transition PENDING -> TRIGGERED, recording triggerPriceObserved.
 *   4. Enqueue execute-order with jobId = orderId.
 *
 * It does not quote and does not touch the wallet. Keeping evaluation free of
 * side effects is what makes it safe to run on a tight interval.
 */

// TODO(impl)
export {};
