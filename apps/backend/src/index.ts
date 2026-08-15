import 'dotenv/config';
import { prisma } from '@soe/database';

import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { assertCorrectChain } from './blockchain/clients.js';
import { logger } from './lib/logger.js';

/**
 * API process entrypoint.
 *
 * This process reads chain state and owns the database. It never signs a
 * transaction and never loads EXECUTOR_PRIVATE_KEY — the signing key belongs to
 * the worker process alone.
 */
async function main(): Promise<void> {
  const env = loadEnv();

  // Fail fast on a misconfigured RPC. Discovering mid-execution that the
  // endpoint points at the wrong chain is far worse than refusing to boot.
  await assertCorrectChain();
  logger.info({ chainId: env.CHAIN_ID }, 'Connected to Ethereum Sepolia');

  const app = createApp();
  const server = app.listen(env.API_PORT, () => {
    logger.info(
      { port: env.API_PORT, contract: env.EXECUTOR_CONTRACT_ADDRESS },
      'API listening',
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Failed to start API');
  process.exitCode = 1;
});
