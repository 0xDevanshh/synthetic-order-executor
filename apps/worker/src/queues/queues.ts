import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

import { QUEUE } from './names.js';
import type { ExecutionPipeline } from '../trigger/triggerEngine.js';

/**
 * BullMQ requires maxRetriesPerRequest: null on the connection its workers use;
 * ioredis's default retry behaviour breaks blocking commands.
 */
export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createConnectionOptions(url: string): ConnectionOptions {
  return { url } as ConnectionOptions;
}

/**
 * BullMQ-backed handoff to the execution pipeline.
 *
 * `jobId = orderId` is the important detail: BullMQ refuses a duplicate job id
 * while one is active, waiting or delayed, so a re-enqueue of the same order
 * collapses into the existing job. That is the queue-level layer of duplicate
 * protection, sitting on top of the database compare-and-swap and the
 * contract's executionId guard.
 */
export class BullExecutionPipeline implements ExecutionPipeline {
  constructor(private readonly queue: Queue) {}

  async enqueue(orderId: string): Promise<void> {
    await this.queue.add(
      'execute',
      { orderId },
      {
        jobId: orderId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: false,
      },
    );
  }
}

export function createExecuteOrderQueue(connection: IORedis): Queue {
  return new Queue(QUEUE.EXECUTE_ORDER, { connection });
}

export function createPriceWatcherQueue(connection: IORedis): Queue {
  return new Queue(QUEUE.PRICE_WATCHER, { connection });
}

export function createTxMonitorQueue(connection: IORedis): Queue {
  return new Queue(QUEUE.TX_MONITOR, { connection });
}

export function createReconcilerQueue(connection: IORedis): Queue {
  return new Queue(QUEUE.RECONCILER, { connection });
}

/**
 * Handoff from the executor to the transaction monitor.
 *
 * Distinct from BullExecutionPipeline on purpose. Enqueueing a MONITOR job is
 * always safe — it only causes reads. Enqueueing an EXECUTION job may cause a
 * transaction. Keeping them as separate types makes it hard to confuse the two
 * at a call site.
 */
export class BullMonitorPipeline {
  constructor(private readonly queue: Queue) {}

  async enqueue(orderId: string): Promise<void> {
    await this.queue.add(
      'check',
      { orderId },
      {
        jobId: `${orderId}:initial`,
        delay: 5_000,
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    );
  }
}
