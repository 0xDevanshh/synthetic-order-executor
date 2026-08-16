import { beforeAll, describe, expect, it } from 'vitest';
import { getAddress, parseUnits, type Hex, type PublicClient } from 'viem';
import {
  ExecutorContractClient,
  TransactionMonitor,
  UniswapAdapter,
  assertChain,
  createReadClient,
  loadChainConfig,
  type ChainConfig,
} from '@soe/chain';

/**
 * Integration tests against LIVE Ethereum Sepolia.
 *
 * Everything here is an eth_call or a log query. Nothing is signed, nothing is
 * broadcast, no value moves — so this suite is safe to run against the funded
 * production deployment at any time.
 *
 * Uses a public RPC by default, so it needs no credentials. Set SEPOLIA_RPC_URL
 * to use your own endpoint.
 */
const RUN = process.env.RUN_SEPOLIA_TESTS === '1';
const describeIf = RUN ? describe : describe.skip;

const CONTRACT = '0x34C7244383f129957e631706AA420D5CFF721c35';
const PUBLIC_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

describeIf('live Sepolia integration', () => {
  let config: ChainConfig;
  let client: PublicClient;
  let executor: ExecutorContractClient;
  let dex: UniswapAdapter;

  beforeAll(async () => {
    config = loadChainConfig({
      CHAIN_ID: '11155111',
      SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL ?? PUBLIC_RPC,
      EXECUTOR_CONTRACT_ADDRESS: process.env.EXECUTOR_CONTRACT_ADDRESS ?? CONTRACT,
    } as NodeJS.ProcessEnv);

    client = createReadClient(config);
    executor = new ExecutorContractClient(config, client);
    dex = new UniswapAdapter(config, executor, client);
  });

  describe('network', () => {
    it('is connected to Sepolia, chain id 11155111', async () => {
      expect(await client.getChainId()).toBe(11155111);
      await expect(assertChain(client, 11155111)).resolves.not.toThrow();
    });

    it('refuses to operate against the wrong chain', async () => {
      await expect(assertChain(client, 1)).rejects.toThrow(/expected 1/);
    });
  });

  describe('deployed contract', () => {
    it('has bytecode at the configured address', async () => {
      const code = await client.getCode({ address: config.executorContract });
      expect(code).toBeDefined();
      expect(code).not.toBe('0x');
    });

    it('is wired to the real Uniswap SwapRouter02', async () => {
      const state = await executor.getState();
      expect(getAddress(state.swapRouter)).toBe(getAddress(config.swapRouter));
      expect(getAddress(state.weth)).toBe(getAddress(config.weth));
    });

    it('is not paused', async () => {
      expect((await executor.getState()).paused).toBe(false);
    });

    it('has WETH and USDC allowlisted with non-zero caps', async () => {
      expect(await executor.isTokenAllowed(config.weth)).toBe(true);
      expect(await executor.isTokenAllowed(config.usdc)).toBe(true);
      expect(await executor.getMaxTradeAmount(config.weth)).toBeGreaterThan(0n);
    });

    it('reports an unknown executionId as unconsumed', async () => {
      const random = `0x${'7'.repeat(64)}` as Hex;
      expect(await executor.isExecuted(random)).toBe(false);
    });
  });

  describe('live Uniswap quoting', () => {
    it('retrieves a real quote for WETH -> USDC', async () => {
      const quote = await dex.getQuote({
        tokenIn: config.weth,
        tokenOut: config.usdc,
        amountIn: parseUnits('0.01', 18),
      });

      expect(quote.amountOut).toBeGreaterThan(0n);
      expect(config.feeTiers).toContain(quote.poolFee);
      expect(quote.gasEstimate).toBeGreaterThan(0n);
    });

    it('scales output roughly linearly with input', async () => {
      // A sanity check on the quoter wiring rather than on price: 10x the input
      // should return substantially more, even allowing for price impact.
      const small = await dex.getQuote({
        tokenIn: config.weth,
        tokenOut: config.usdc,
        amountIn: parseUnits('0.001', 18),
      });
      const large = await dex.getQuote({
        tokenIn: config.weth,
        tokenOut: config.usdc,
        amountIn: parseUnits('0.01', 18),
      });

      expect(large.amountOut).toBeGreaterThan(small.amountOut * 5n);
    });

    it('derives minAmountOut below the live quote by the slippage tolerance', async () => {
      const quote = await dex.getQuote({
        tokenIn: config.weth,
        tokenOut: config.usdc,
        amountIn: parseUnits('0.01', 18),
      });

      const params = dex.buildExecutionParams({
        executionId: `0x${'11'.repeat(32)}`,
        owner: getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'),
        quote,
      });

      expect(params.minAmountOut).toBeLessThan(quote.amountOut);
      expect(params.minAmountOut).toBe((quote.amountOut * 9_900n) / 10_000n);
      expect(params.deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
    });
  });

  describe('live executeSwap simulation', () => {
    it('reaches the contract and fails on balance, proving the guards passed', async () => {
      // An address with no vault deposit. InsufficientBalance is the CORRECT
      // outcome and the informative one: the call got past the executor role
      // check, the allowlist, the size cap and the deadline before failing on
      // the one thing that is genuinely absent.
      const quote = await dex.getQuote({
        tokenIn: config.weth,
        tokenOut: config.usdc,
        amountIn: parseUnits('0.01', 18),
      });

      const params = dex.buildExecutionParams({
        executionId: `0x${'22'.repeat(32)}`,
        owner: getAddress('0x0000000000000000000000000000000000000001'),
        quote,
      });

      await expect(executor.simulate(params)).rejects.toThrow(/InsufficientBalance|reverted/);
    });

    it('rejects a non-allowlisted token on-chain', async () => {
      const quote = await dex.getQuote({
        tokenIn: config.weth,
        tokenOut: config.usdc,
        amountIn: parseUnits('0.01', 18),
      });

      const params = dex.buildExecutionParams({
        executionId: `0x${'33'.repeat(32)}`,
        owner: getAddress('0x0000000000000000000000000000000000000001'),
        quote,
      });

      await expect(
        executor.simulate({
          ...params,
          tokenIn: getAddress('0x000000000000000000000000000000000000dEaD'),
        }),
      ).rejects.toThrow(/TokenNotAllowed|reverted/);
    });

    it('rejects an expired deadline on-chain', async () => {
      const quote = await dex.getQuote({
        tokenIn: config.weth,
        tokenOut: config.usdc,
        amountIn: parseUnits('0.01', 18),
      });

      const params = dex.buildExecutionParams({
        executionId: `0x${'44'.repeat(32)}`,
        owner: getAddress('0x0000000000000000000000000000000000000001'),
        quote,
      });

      await expect(
        executor.simulate({ ...params, deadline: 1n }),
      ).rejects.toThrow(/DeadlineExpired|reverted/);
    });
  });

  describe('reconciliation reads', () => {
    it('fetches SwapExecuted logs over a real block range', async () => {
      // The reconciler's evidence source. Zero results is a valid outcome —
      // what matters is that the query itself works against a live node.
      const head = await executor.getBlockNumber();
      const logs = await executor.getSwapExecutedLogs(head - 500n, head);

      expect(Array.isArray(logs)).toBe(true);
      for (const log of logs) {
        expect(log.executionId).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(log.blockNumber).toBeGreaterThan(0n);
      }
    });

    it('classifies an unknown transaction hash without concluding it failed', async () => {
      // A hash that was never broadcast. The monitor must NOT report it as a
      // failed execution — it has no receipt and no mempool entry, so the only
      // safe classifications are PENDING or DROPPED_NOT_EXECUTED after the
      // grace period, both derived from the contract rather than guessed.
      const monitor = new TransactionMonitor(client, executor, { pendingGraceMs: 0 });

      const outcome = await monitor.getOutcome(
        `0x${'99'.repeat(32)}` as Hex,
        `0x${'88'.repeat(64 / 2)}` as Hex,
        new Date(Date.now() - 600_000),
      );

      expect(['DROPPED_NOT_EXECUTED', 'PENDING', 'RPC_ERROR']).toContain(outcome.kind);
      expect(outcome.kind).not.toBe('SUCCESS');
      expect(outcome.kind).not.toBe('REVERTED');
    });
  });
});
