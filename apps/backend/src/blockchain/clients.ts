import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';
import { loadEnv } from '../config/env.js';

/**
 * Read-only viem client for Ethereum Sepolia.
 *
 * Holds no keys. The API process reads chain state — allowlist, caps, paused,
 * execution status — and never signs anything.
 *
 * Two providers behind `fallback` so a single flaky RPC does not take the API
 * down. viem rotates automatically on failure.
 */
let cached: PublicClient | undefined;

export function getPublicClient(): PublicClient {
  if (cached) return cached;

  const env = loadEnv();
  const urls = [env.SEPOLIA_RPC_URL, env.SEPOLIA_RPC_URL_FALLBACK].filter(
    (u): u is string => Boolean(u),
  );

  cached = createPublicClient({
    chain: sepolia,
    transport: fallback(urls.map((url) => http(url, { timeout: 10_000 }))),
  });

  return cached;
}

/**
 * Assert the RPC really is Sepolia before serving traffic.
 *
 * Called at boot. A misconfigured endpoint that agrees syntactically but points
 * at another chain would otherwise surface as inexplicable reverts against a
 * contract address that holds different code — this turns that into an
 * immediate, obvious startup failure.
 */
export async function assertCorrectChain(): Promise<void> {
  const env = loadEnv();
  const chainId = await getPublicClient().getChainId();
  if (chainId !== env.CHAIN_ID) {
    throw new Error(
      `RPC reports chain id ${chainId}, expected ${env.CHAIN_ID} (Sepolia). Check SEPOLIA_RPC_URL.`,
    );
  }
}

export function resetClientCache(): void {
  cached = undefined;
}
