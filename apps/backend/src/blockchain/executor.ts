import {
  ExecutorContractClient,
  assertChain,
  createReadClient,
  loadChainConfig,
  type ChainConfig,
} from '@soe/chain';
import type { PublicClient } from 'viem';

/**
 * The API's read-only view of the chain.
 *
 * Thin wrappers over @soe/chain so the API depends on the same client the worker
 * uses, rather than a second implementation that could drift from it.
 *
 * This process never supplies EXECUTOR_PRIVATE_KEY, so the client it builds has
 * no signer and any write attempt fails loudly.
 */
let cachedConfig: ChainConfig | undefined;
let cachedRead: PublicClient | undefined;
let cachedExecutor: ExecutorContractClient | undefined;

export function getChainConfig(): ChainConfig {
  if (!cachedConfig) cachedConfig = loadChainConfig();
  return cachedConfig;
}

export function getPublicClient(): PublicClient {
  if (!cachedRead) cachedRead = createReadClient(getChainConfig());
  return cachedRead;
}

export function getExecutorClient(): ExecutorContractClient {
  if (!cachedExecutor) {
    cachedExecutor = new ExecutorContractClient(getChainConfig(), getPublicClient());
  }
  return cachedExecutor;
}

/** Refuse to serve traffic against the wrong chain. */
export async function assertCorrectChain(): Promise<void> {
  await assertChain(getPublicClient(), getChainConfig().chainId);
}

/** Test seam. */
export function resetChainCaches(): void {
  cachedConfig = undefined;
  cachedRead = undefined;
  cachedExecutor = undefined;
}
