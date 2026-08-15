import 'dotenv/config';
import { prisma } from '@soe/database';
import { OrderRepository } from '@soe/core';

import { loadEnv } from './config/env.js';
import { buildPriceService } from './price/factory.js';
import { TriggerEngine } from './trigger/triggerEngine.js';
import {
  BullExecutionPipeline,
  createExecuteOrderQueue,
  createPriceWatcherQueue,
  createRedisConnection,
} from './queues/queues.js';
import {
  createPriceWatcherWorker,
  schedulePriceWatcher,
} from './workers/priceWatcher.worker.js';
import { logger } from './lib/logger.js';

/**
 * Worker process entrypoint.
 *
 * Currently runs the price watcher / trigger engine only. It moves orders
 * PENDING -> TRIGGERED and hands them to the execute-order queue; it holds no
 * signing key and submits no transactions. The consumer of execute-order is the
 * next milestone.
 */
async function main(): Promise<void> {
  const env = loadEnv();

  const priceService = buildPriceService(env);
  const connection = createRedisConnection(env.REDIS_URL);

  const executeQueue = createExecuteOrderQueue(connection);
  const priceQueue = createPriceWatcherQueue(connection);

  const engine = new TriggerEngine(
    priceService,
    new OrderRepository(prisma),
    new BullExecutionPipeline(executeQueue),
    logger,
    env.TRIGGER_BATCH_SIZE,
  );

  const worker = createPriceWatcherWorker(connection, engine);
  await schedulePriceWatcher(priceQueue, env.PRICE_POLL_INTERVAL_MS);

  logger.info(
    {
      provider: env.PRICE_PROVIDER,
      crossCheck: env.PRICE_CROSSCHECK_PROVIDER,
      intervalMs: env.PRICE_POLL_INTERVAL_MS,
      batchSize: env.TRIGGER_BATCH_SIZE,
    },
    'price watcher started',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    // Let an in-flight evaluation finish rather than killing it mid-claim.
    await worker.close();
    await executeQueue.close();
    await priceQueue.close();
    await connection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'failed to start worker');
  process.exitCode = 1;
});
