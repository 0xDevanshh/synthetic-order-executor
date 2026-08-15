import 'dotenv/config';
import { prisma } from '@soe/database';
import { OrderRepository } from '@soe/core';
import {
  ExecutorContractClient,
  UniswapAdapter,
  assertChain,
  createReadClient,
  loadChainConfig,
} from '@soe/chain';

import { loadEnv } from './config/env.js';
import { buildPriceService } from './price/factory.js';
import { TriggerEngine } from './trigger/triggerEngine.js';
import { ExecutionService, createTokenRegistry } from './execution/execution.service.js';
import {
  BullExecutionPipeline,
  createExecuteOrderQueue,
  createPriceWatcherQueue,
  createRedisConnection,
} from './queues/queues.js';
import { createPriceWatcherWorker, schedulePriceWatcher } from './workers/priceWatcher.worker.js';
import { createExecutorWorker } from './workers/executor.worker.js';
import { logger } from './lib/logger.js';

/**
 * Worker process entrypoint.
 *
 * Runs both halves of the engine:
 *   price watcher   PENDING   -> TRIGGERED   (decides WHEN)
 *   executor        TRIGGERED -> EXECUTED    (submits, within contract limits)
 *
 * This is the only process holding EXECUTOR_PRIVATE_KEY.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const chain = loadChainConfig();

  const readClient = createReadClient(chain);
  await assertChain(readClient, chain.chainId);

  const executor = new ExecutorContractClient(chain, readClient);
  if (!executor.hasSigner) {
    throw new Error('EXECUTOR_PRIVATE_KEY is required: the worker cannot submit without it');
  }

  const contractState = await executor.getState();
  if (contractState.executor.toLowerCase() !== executor.executorAddress?.toLowerCase()) {
    // Every submission would revert with AccessControlUnauthorizedAccount.
    // Better to refuse to start than to burn gas discovering that per order.
    throw new Error(
      `Configured key ${executor.executorAddress} is not the contract's executor ` +
        `(${contractState.executor}). Run configure.ts or fix EXECUTOR_PRIVATE_KEY.`,
    );
  }

  const dex = new UniswapAdapter(chain, executor, readClient);
  const repository = new OrderRepository(prisma);
  const connection = createRedisConnection(env.REDIS_URL);

  const executeQueue = createExecuteOrderQueue(connection);
  const priceQueue = createPriceWatcherQueue(connection);

  const triggerEngine = new TriggerEngine(
    buildPriceService(env),
    repository,
    new BullExecutionPipeline(executeQueue),
    logger,
    env.TRIGGER_BATCH_SIZE,
  );

  const executionService = new ExecutionService(
    repository,
    dex,
    executor,
    createTokenRegistry(chain),
    logger,
  );

  const priceWorker = createPriceWatcherWorker(connection, triggerEngine);
  const executorWorker = createExecutorWorker(connection, executionService);
  await schedulePriceWatcher(priceQueue, env.PRICE_POLL_INTERVAL_MS);

  logger.info(
    {
      contract: chain.executorContract,
      executor: executor.executorAddress,
      dex: dex.name,
      priceProvider: env.PRICE_PROVIDER,
      slippageBps: chain.slippageBps,
      deadlineWindowSec: chain.deadlineWindowSec,
    },
    'worker started: price watcher + executor',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    // Let an in-flight execution finish. Killing a worker between signing and
    // broadcasting is the one thing that creates genuinely ambiguous state.
    await Promise.all([priceWorker.close(), executorWorker.close()]);
    await Promise.all([executeQueue.close(), priceQueue.close()]);
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
