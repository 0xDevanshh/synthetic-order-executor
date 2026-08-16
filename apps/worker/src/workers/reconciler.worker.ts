import { Worker, type Queue } from 'bullmq';
import type IORedis from 'ioredis';

import { QUEUE } from '../queues/names.js';
import type { ReconcilerService } from '../reconcile/reconciler.service.js';
import { logger } from '../lib/logger.js';

export const RECONCILE_JOB = 'reconcile';

/**
 * Periodic reconciliation worker.
 *
 * Concurrency 1: two overlapping passes would race on the same checkpoint and
 * re-scan the same logs for no benefit. The work is read-heavy and the passes
 * are idempotent, so overlap is harmless but wasteful — serialising is simply
 * correct.
 *
 * The job never rejects on a pass failure. `ReconcilerService.run` collects
 * per-pass errors into its report instead, because a failing pass is an
 * expected operating condition (RPC down) and burning BullMQ's retry budget on
 * it would only delay the next scheduled pass.
 */
export function createReconcilerWorker(
  connection: IORedis,
  service: ReconcilerService,
): Worker {
  const worker = new Worker(
    QUEUE.RECONCILER,
    async () => {
      const report = await service.run();

      if (report.errors.length > 0) {
        logger.warn({ errors: report.errors }, 'reconciliation completed with pass failures');
      }

      return report;
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'reconciler job failed');
  });

  return worker;
}

/**
 * Register the repeatable pass.
 *
 * Fixed jobId so a worker restart cannot stack duplicate schedulers, which
 * would multiply the scan rate on every deploy.
 */
export async function scheduleReconciler(queue: Queue, intervalMs: number): Promise<void> {
  await queue.add(
    RECONCILE_JOB,
    {},
    {
      jobId: 'reconciler-repeatable',
      repeat: { every: intervalMs },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );
}
