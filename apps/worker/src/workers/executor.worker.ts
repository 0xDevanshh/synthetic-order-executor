import { Worker } from 'bullmq';
import type IORedis from 'ioredis';

import { QUEUE } from '../queues/names.js';
import type { ExecutionService } from '../execution/execution.service.js';
import { logger } from '../lib/logger.js';

export interface ExecuteOrderJob {
  orderId: string;
}

/**
 * Consumer for the execute-order queue.
 *
 * Concurrency is 1, and that is not tunable without more work: the executor EOA
 * has a single nonce sequence, so two in-flight submissions would collide on it.
 * Scaling means a signer pool, which is deliberately out of scope.
 *
 * Retries are handled by the queue, and they are safe specifically because
 * duplicate execution is impossible on-chain — the executionId guard rejects a
 * replay regardless of how many times this worker tries.
 */
export function createExecutorWorker(
  connection: IORedis,
  execution: ExecutionService,
): Worker<ExecuteOrderJob> {
  const worker = new Worker<ExecuteOrderJob>(
    QUEUE.EXECUTE_ORDER,
    async (job) => {
      const { orderId } = job.data;
      logger.info({ orderId, attempt: job.attemptsMade + 1 }, 'processing execution job');
      return execution.executeOrder(orderId);
    },
    {
      connection,
      concurrency: 1,
      // A submitted transaction can take minutes to mine; the lock must outlast
      // that or BullMQ will hand the same order to another worker mid-flight.
      lockDuration: 360_000,
    },
  );

  worker.on('completed', (job, result) => {
    logger.info({ orderId: job.data.orderId, result }, 'execution job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ orderId: job?.data.orderId, err: error }, 'execution job failed');
  });

  return worker;
}
