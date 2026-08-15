/**
 * BullMQ queue construction and job options.
 *
 * Two conventions that carry real weight:
 *   - `jobId = orderId` on execute-order, so BullMQ itself deduplicates
 *     enqueues for the same order.
 *   - Repeatable jobs use fixed jobIds, so a worker restart does not stack
 *     duplicate schedulers.
 *
 * Retries are exponential with attempts: 3, but the executor only retries
 * failures it has classified as retryable. A contract revert is never retried.
 */

// TODO(impl)
export {};
