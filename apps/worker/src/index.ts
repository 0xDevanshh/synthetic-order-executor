import 'dotenv/config';
import { prisma } from '@soe/database';
import { OrderRepository, ReconciliationRepository } from '@soe/core';
import {
  ExecutorContractClient,
  TransactionMonitor,
  UniswapAdapter,
  buildPriceService,
  assertChain,
  createReadClient,
  loadChainConfig,
} from '@soe/chain';

import { loadEnv } from './config/env.js';
import { TriggerEngine } from './trigger/triggerEngine.js';
import { ExecutionService, createTokenRegistry } from './execution/execution.service.js';
import { TxMonitorService } from './monitor/txMonitor.service.js';
import { ReconcilerService } from './reconcile/reconciler.service.js';
import {
  BullExecutionPipeline,
  BullMonitorPipeline,
  createExecuteOrderQueue,
  createPriceWatcherQueue,
  createTxMonitorQueue,
  createReconcilerQueue,
  createRedisConnection,
} from './queues/queues.js';
import { createPriceWatcherWorker, schedulePriceWatcher } from './workers/priceWatcher.worker.js';
import { createExecutorWorker } from './workers/executor.worker.js';
import { createTxMonitorWorker, scheduleSweep } from './workers/txMonitor.worker.js';
import { createReconcilerWorker, scheduleReconciler } from './workers/reconciler.worker.js';
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
  const monitorQueue = createTxMonitorQueue(connection);
  const reconcilerQueue = createReconcilerQueue(connection);

  const triggerEngine = new TriggerEngine(
    buildPriceService({
      provider: env.PRICE_PROVIDER,
      crossCheck: env.PRICE_CROSSCHECK_PROVIDER,
      staticPrice: env.STATIC_PRICE,
      rpcUrl: env.SEPOLIA_RPC_URL,
      chainlinkFeed: env.CHAINLINK_ETH_USD_FEED as `0x${string}`,
      maxStalenessSec: env.MAX_PRICE_STALENESS_SEC,
      maxDivergenceBps: env.MAX_PRICE_DIVERGENCE_BPS,
    }),
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
    new BullMonitorPipeline(monitorQueue),
    logger,
  );

  const txMonitorService = new TxMonitorService(
    repository,
    new TransactionMonitor(readClient, executor, { pendingGraceMs: env.PENDING_GRACE_MS }),
    logger,
  );

  const reconcilerService = new ReconcilerService(
    repository,
    new ReconciliationRepository(prisma),
    executor,
    txMonitorService,
    logger,
    {
      stuckAfterMs: env.TX_STUCK_AFTER_MS,
      reorgBufferBlocks: BigInt(env.REORG_BUFFER_BLOCKS),
      maxBlockRange: BigInt(env.RECONCILE_MAX_BLOCK_RANGE),
      auditLimit: env.RECONCILE_AUDIT_LIMIT,
    },
  );

  const priceWorker = createPriceWatcherWorker(connection, triggerEngine);
  const executorWorker = createExecutorWorker(connection, executionService);
  const monitorWorker = createTxMonitorWorker(connection, txMonitorService, monitorQueue, {
    recheckDelayMs: env.TX_RECHECK_DELAY_MS,
    stuckAfterMs: env.TX_STUCK_AFTER_MS,
  });

  const reconcilerWorker = createReconcilerWorker(connection, reconcilerService);

  await schedulePriceWatcher(priceQueue, env.PRICE_POLL_INTERVAL_MS);
  await scheduleSweep(monitorQueue, env.TX_SWEEP_INTERVAL_MS);
  await scheduleReconciler(reconcilerQueue, env.RECONCILE_INTERVAL_MS);

  logger.info(
    {
      contract: chain.executorContract,
      executor: executor.executorAddress,
      dex: dex.name,
      priceProvider: env.PRICE_PROVIDER,
      slippageBps: chain.slippageBps,
      deadlineWindowSec: chain.deadlineWindowSec,
    },
    'worker started: price watcher + executor + tx monitor + reconciler',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    // Let an in-flight execution finish. Killing a worker between signing and
    // broadcasting is the one thing that creates genuinely ambiguous state.
    await Promise.all([
      priceWorker.close(),
      executorWorker.close(),
      monitorWorker.close(),
      reconcilerWorker.close(),
    ]);
    await Promise.all([
      executeQueue.close(),
      priceQueue.close(),
      monitorQueue.close(),
      reconcilerQueue.close(),
    ]);
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
