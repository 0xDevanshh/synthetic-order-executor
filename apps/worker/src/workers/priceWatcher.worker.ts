import { Worker, type Queue } from 'bullmq';
import type IORedis from 'ioredis';

import { QUEUE } from '../queues/names.js';
import { TriggerEngine } from '../trigger/triggerEngine.js';
import { PriceUnavailableError, PriceUntrustedError } from '../price/PriceProvider.js';
import { logger } from '../lib/logger.js';

export const PRICE_WATCHER_JOB = 'evaluate-triggers';

/**
 * BullMQ adapter around TriggerEngine.
 *
 * Intentionally thin: scheduling, retries and logging live here, and every
 * decision about whether an order fires lives in the engine, which needs no
 * Redis to test.
 *
 * This worker NEVER submits a blockchain transaction. It moves orders
 * PENDING -> TRIGGERED and hands the id to the execution pipeline. Keeping
 * signing out of the watcher means a bug in price handling cannot spend gas.
 */
export function createPriceWatcherWorker(
  connection: IORedis,
  engine: TriggerEngine,
  asset = 'ETH/USD',
): Worker {
  const worker = new Worker(
    QUEUE.PRICE_WATCHER,
    async () => {
      try {
        return await engine.run(asset);
      } catch (error) {
        // A bad or untrustworthy price is an expected operating condition, not a
        // crash: the feed is down, or two sources disagree. Log it and let the
        // next tick try. Nothing fires, which is the safe outcome — an order
        // that misses a tick fires on the next one; an order that fires on a bad
        // price cannot be un-fired.
        if (error instanceof PriceUnavailableError || error instanceof PriceUntrustedError) {
          logger.warn({ err: error.message, asset }, 'skipping tick: no trustworthy price');
          return { skippedReason: error.message };
        }
        throw error;
      }
    },
    {
      connection,
      // One evaluator. Concurrency here would have several passes racing the
      // same candidate set — the compare-and-swap makes that safe, but it is
      // pure waste. Throughput comes from the batch size, not from parallel
      // watchers.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'price watcher job failed');
  });

  return worker;
}

/**
 * Register the repeatable evaluation job.
 *
 * A fixed jobId keeps a worker restart from stacking duplicate schedulers, which
 * would otherwise multiply the poll rate every deploy.
 */
export async function schedulePriceWatcher(
  queue: Queue,
  intervalMs: number,
): Promise<void> {
  await queue.add(
    PRICE_WATCHER_JOB,
    {},
    {
      jobId: 'price-watcher-repeatable',
      repeat: { every: intervalMs },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );
}
