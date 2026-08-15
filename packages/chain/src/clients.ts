import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import type { ChainConfig } from './config.js';

/** Read-only client. Holds no key; safe in any process. */
export function createReadClient(config: ChainConfig): PublicClient {
  return createPublicClient({
    chain: sepolia,
    transport: fallback(config.rpcUrls.map((url) => http(url, { timeout: 15_000 }))),
  });
}

/**
 * Signing client for the executor hot wallet.
 *
 * Returns undefined when no key is configured, which is the API process's normal
 * state. Callers must handle that rather than assume a signer exists — the
 * absence of a key is a deployment property, not an error.
 *
 * The account object is never logged. In production this should be swapped for a
 * KMS/Vault signer behind the same interface; because the contract requires
 * EXECUTOR_ROLE and credits output back to the order owner, compromising this
 * key yields griefing rather than theft.
 */
export function createSigningClient(
  config: ChainConfig,
): { client: WalletClient; account: Account } | undefined {
  if (!config.executorPrivateKey) return undefined;

  const account = privateKeyToAccount(config.executorPrivateKey);

  return {
    account,
    client: createWalletClient({
      account,
      chain: sepolia,
      transport: fallback(config.rpcUrls.map((url) => http(url, { timeout: 15_000 }))),
    }),
  };
}

/**
 * Refuse to operate against the wrong chain.
 *
 * An RPC pointing at another network would otherwise surface as inexplicable
 * reverts against an address holding entirely different code.
 */
export async function assertChain(client: PublicClient, expected: number): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expected) {
    throw new Error(`RPC reports chain id ${actual}, expected ${expected} (Sepolia)`);
  }
}
