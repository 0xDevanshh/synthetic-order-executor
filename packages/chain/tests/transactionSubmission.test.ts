import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress, parseUnits, type Hex, type PublicClient } from 'viem';

import { ExecutorContractClient } from '../src/contract/executorClient.js';
import { NoSignerError, type ExecutionParams } from '../src/dex/DexAdapter.js';
import type { ChainConfig } from '../src/config.js';

/**
 * Hardhat's well-known account #0 key. Published in Hardhat's own docs and used
 * by every tutorial — it holds nothing and is safe to commit. It exists here so
 * signing runs for real (locally, no network) rather than being stubbed.
 */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ACCOUNT = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');

const WETH = getAddress('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');
const USDC = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');

function buildConfig(withKey: boolean): ChainConfig {
  return {
    chainId: 11155111,
    rpcUrls: ['https://sepolia.example.invalid'],
    executorContract: getAddress('0x34C7244383f129957e631706AA420D5CFF721c35'),
    executorPrivateKey: withKey ? TEST_KEY : undefined,
    swapRouter: getAddress('0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E'),
    quoterV2: getAddress('0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3'),
    factory: getAddress('0x0227628f3F023bb0B980b67D528571c95c6DaC1c'),
    feeTiers: [3000],
    weth: WETH,
    usdc: USDC,
    slippageBps: 100,
    deadlineWindowSec: 120,
    maxFeePerGasGwei: 100,
  };
}

const params: ExecutionParams = {
  executionId: `0x${'11'.repeat(32)}`,
  owner: getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'),
  tokenIn: WETH,
  tokenOut: USDC,
  poolFee: 3000,
  amountIn: parseUnits('0.01', 18),
  minAmountOut: parseUnits('34.65', 6),
  deadline: BigInt(Math.floor(Date.now() / 1000)) + 120n,
};

/** Records the exact order of RPC operations, which is what these tests assert. */
class MockRpc {
  events: string[] = [];
  simulateError: Error | undefined;
  broadcastError: Error | undefined;
  suggestedMaxFee = 20_000_000_000n; // 20 gwei
  lastPreparedMaxFee: bigint | undefined;

  asClient(): PublicClient {
    const self = this;
    return {
      async simulateContract() {
        self.events.push('simulate');
        if (self.simulateError) throw self.simulateError;
        return { result: parseUnits('35', 6) };
      },
      async estimateFeesPerGas() {
        self.events.push('estimateFees');
        return { maxFeePerGas: self.suggestedMaxFee, maxPriorityFeePerGas: 1_000_000_000n };
      },
      async prepareTransactionRequest(req: { maxFeePerGas: bigint }) {
        self.events.push('prepare');
        self.lastPreparedMaxFee = req.maxFeePerGas;
        return {
          ...req,
          nonce: 7,
          gas: 300_000n,
          type: 'eip1559',
          chainId: 11155111,
        };
      },
      async sendRawTransaction() {
        self.events.push('broadcast');
        if (self.broadcastError) throw self.broadcastError;
        return `0x${'cd'.repeat(32)}` as Hex;
      },
      async readContract() {
        return false;
      },
    } as unknown as PublicClient;
  }
}

describe('transaction submission (ExecutorContractClient.submit)', () => {
  let rpc: MockRpc;
  let client: ExecutorContractClient;

  beforeEach(() => {
    rpc = new MockRpc();
    client = new ExecutorContractClient(buildConfig(true), rpc.asClient());
  });

  describe('contract call', () => {
    it('simulates before signing anything', async () => {
      await client.submit(params);

      // Simulation is free and catches every contract revert. Signing first
      // would spend gas discovering what a call could have told us.
      expect(rpc.events[0]).toBe('simulate');
    });

    it('does not broadcast when simulation reverts', async () => {
      rpc.simulateError = new Error('TokenNotAllowed');

      await expect(client.submit(params)).rejects.toThrow('TokenNotAllowed');
      expect(rpc.events).not.toContain('broadcast');
    });

    it('caps maxFeePerGas at the configured ceiling', async () => {
      // An RPC returning a wild estimate during congestion must not drain the
      // hot wallet's gas budget on a single transaction.
      rpc.suggestedMaxFee = 500_000_000_000n; // 500 gwei, above the 100 cap
      await client.submit(params);

      expect(rpc.lastPreparedMaxFee).toBe(100_000_000_000n);
    });

    it('uses the RPC estimate when it is below the ceiling', async () => {
      rpc.suggestedMaxFee = 5_000_000_000n;
      await client.submit(params);

      expect(rpc.lastPreparedMaxFee).toBe(5_000_000_000n);
    });

    it('refuses to submit without a signer', async () => {
      const readOnly = new ExecutorContractClient(buildConfig(false), rpc.asClient());

      await expect(readOnly.submit(params)).rejects.toThrow(NoSignerError);
      expect(rpc.events).not.toContain('broadcast');
      expect(readOnly.hasSigner).toBe(false);
    });

    it('exposes the executor address derived from the key', () => {
      expect(client.executorAddress).toBe(TEST_ACCOUNT);
    });
  });

  describe('txHash persistence ordering', () => {
    it('hands the hash to the callback BEFORE broadcasting', async () => {
      // The single most important ordering in the system. Broadcasting first
      // leaves a window where a transaction exists on the network that the
      // database has no record of — die there and the order looks unexecuted
      // forever while the swap settles, with no hash to reconcile against.
      const order: string[] = [];

      await client.submit(params, async (hash) => {
        order.push(`persisted:${hash.slice(0, 6)}`);
        rpc.events.push('persist');
      });

      const persistIndex = rpc.events.indexOf('persist');
      const broadcastIndex = rpc.events.indexOf('broadcast');

      expect(persistIndex).toBeGreaterThan(-1);
      expect(broadcastIndex).toBeGreaterThan(-1);
      expect(persistIndex).toBeLessThan(broadcastIndex);
      expect(order).toHaveLength(1);
    });

    it('produces a deterministic hash from the locally signed transaction', async () => {
      let captured: Hex | undefined;
      await client.submit(params, async (hash) => {
        captured = hash;
      });

      // Local signing is what makes the hash knowable before anyone else has
      // seen the transaction.
      expect(captured).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('does NOT broadcast when persisting the hash fails', async () => {
      // A DB failure before broadcast is the safe failure: nothing reaches the
      // network, so the order can be retried cleanly with no ambiguity.
      await expect(
        client.submit(params, async () => {
          throw new Error('neon connection lost');
        }),
      ).rejects.toThrow('neon connection lost');

      expect(rpc.events).not.toContain('broadcast');
    });

    it('surfaces a broadcast failure after the hash was already persisted', async () => {
      // The genuinely ambiguous case: the hash is recorded but the send failed.
      // The caller must treat this as "may be live" and defer to the monitor.
      let persisted: Hex | undefined;
      rpc.broadcastError = new Error('socket hang up');

      await expect(
        client.submit(params, async (hash) => {
          persisted = hash;
        }),
      ).rejects.toThrow('socket hang up');

      expect(persisted).toBeDefined();
    });
  });
});
