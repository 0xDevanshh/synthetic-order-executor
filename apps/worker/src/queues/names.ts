/**
 * Queue names — the contract between worker processes.
 *
 * | queue             | kind       | cadence      | concurrency |
 * |-------------------|------------|--------------|-------------|
 * | price-watcher     | repeatable | 10s          | 1           |
 * | trigger-evaluator | repeatable | 10s          | 1           |
 * | execute-order     | on demand  | per order    | 1  (*)      |
 * | tx-monitor        | on demand  | per tx + 15s | 5           |
 * | reconciler        | repeatable | 60s          | 1           |
 *
 * (*) execute-order concurrency is 1 because the executor EOA has a single
 *     nonce sequence. Parallelism would need a signer pool — that is the
 *     scaling path, deliberately out of MVP scope.
 */
export const QUEUE = {
  PRICE_WATCHER: 'price-watcher',
  TRIGGER_EVALUATOR: 'trigger-evaluator',
  EXECUTE_ORDER: 'execute-order',
  TX_MONITOR: 'tx-monitor',
  RECONCILER: 'reconciler',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];
