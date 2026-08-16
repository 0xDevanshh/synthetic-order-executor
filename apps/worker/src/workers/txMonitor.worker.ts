import { Worker, type Queue } from 'bullmq';
import type IORedis from 'ioredis';

import { QUEUE } from '../queues/names.js';
import type { TxMonitorService } from '../monitor/txMonitor.service.js';
import { logger } from '../lib/logger.js';

export interface TxMonitorJob {
  orderId: string;
}

export const SWEEP_JOB = 'sweep-stuck-executing';

/**
 * Consumer for the tx-monitor queue.
 *
 * Concurrency is 5, unlike the executor's 1. That difference is the point:
 * monitoring is pure reads, so many can run at once without touching the
 * executor's single nonce sequence. Watching is cheap and safe; submitting is
 * neither.
 *
 * When the service reports `requeue`, the job is re-added with a delay rather
 * than thrown — a pending transaction is not a failure, and treating it as one
 * would burn the job's retry budget on the normal case of "the block hasn't
 * been mined yet".
 */
export function createTxMonitorWorker(
  connection: IORedis,
  service: TxMonitorService,
  queue: Queue<TxMonitorJob>,
  options: { recheckDelayMs?: number; stuckAfterMs?: number; sweepLimit?: number } = {},
): Worker<TxMonitorJob> {
  const recheckDelayMs = options.recheckDelayMs ?? 15_000;
  const stuckAfterMs = options.stuckAfterMs ?? 300_000;

  const worker = new Worker<TxMonitorJob>(
    QUEUE.TX_MONITOR,
    async (job) => {
      if (job.name === SWEEP_JOB) {
        return service.sweepStuck(stuckAfterMs, options.sweepLimit ?? 50);
      }

      const result = await service.check(job.data.orderId);

      if (result.requeue) {
        await queue.add(
          'check',
          { orderId: result.orderId },
          {
            // A distinct jobId per attempt: BullMQ refuses a duplicate id while
            // the original is active, so reusing it would silently drop the
            // re-check and strand the order in EXECUTING.
            // BullMQ also rejects ':' in a jobId, hence the '--' separator.
            jobId: `monitor--${result.orderId}--${Date.now()}`,
            delay: recheckDelayMs,
            removeOnComplete: { count: 500 },
            removeOnFail: { count: 500 },
          },
        );
      }

      return result;
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, error) => {
    // Reaching here means the monitor itself threw, not that the transaction
    // failed. The order stays EXECUTING and the sweep will pick it up.
    logger.error(
      { orderId: job?.data.orderId, status: 'UNKNOWN', error: error.message },
      'tx monitor job threw; order left EXECUTING for the sweep',
    );
  });

  return worker;
}

/** Enqueue the first check for a freshly submitted transaction. */
export async function enqueueMonitor(
  queue: Queue<TxMonitorJob>,
  orderId: string,
  delayMs = 5_000,
): Promise<void> {
  await queue.add(
    'check',
    { orderId },
    {
      jobId: `monitor--${orderId}--initial`,
      delay: delayMs,
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 500 },
    },
  );
}

/**
 * Register the repeatable sweep.
 *
 * A fixed jobId keeps a worker restart from stacking duplicate schedulers.
 */
export async function scheduleSweep(
  queue: Queue<TxMonitorJob>,
  intervalMs: number,
): Promise<void> {
  await queue.add(
    SWEEP_JOB,
    { orderId: '' },
    {
      jobId: 'tx-monitor-sweep',
      repeat: { every: intervalMs },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  );
}
