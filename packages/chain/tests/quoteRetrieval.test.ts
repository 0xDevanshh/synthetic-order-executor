import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress, parseUnits, zeroAddress, type PublicClient } from 'viem';

import { UniswapAdapter } from '../src/dex/uniswapAdapter.js';
import { NoLiquidityError } from '../src/dex/DexAdapter.js';
import type { ChainConfig } from '../src/config.js';
import type { ExecutorContractClient } from '../src/contract/executorClient.js';

const WETH = getAddress('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');
const USDC = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
const POOL = getAddress('0x1111111111111111111111111111111111111111');

const config: ChainConfig = {
  chainId: 11155111,
  rpcUrls: ['https://sepolia.example.invalid'],
  executorContract: getAddress('0x34C7244383f129957e631706AA420D5CFF721c35'),
  swapRouter: getAddress('0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E'),
  quoterV2: getAddress('0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3'),
  factory: getAddress('0x0227628f3F023bb0B980b67D528571c95c6DaC1c'),
  feeTiers: [500, 3000, 10000],
  weth: WETH,
  usdc: USDC,
  slippageBps: 100,
  deadlineWindowSec: 120,
  maxFeePerGasGwei: 100,
};

/**
 * Mocked RPC. Tests declare, per fee tier, whether a pool exists, how much
 * liquidity it has, and what the quoter would return — which is every branch
 * `getQuote` can take, with no network involved.
 */
class MockRpc {
  pools = new Map<number, { exists: boolean; liquidity: bigint; amountOut: bigint }>();
  quoterCalls: number[] = [];
  readFailures = new Set<number>();

  setTier(fee: number, opts: { exists?: boolean; liquidity?: bigint; amountOut?: bigint }) {
    this.pools.set(fee, {
      exists: opts.exists ?? true,
      liquidity: opts.liquidity ?? 1_000_000n,
      amountOut: opts.amountOut ?? parseUnits('35', 6),
    });
  }

  asClient(): PublicClient {
    const self = this;
    return {
      async readContract(args: { functionName: string; args?: readonly unknown[] }) {
        if (args.functionName === 'getPool') {
          const fee = Number(args.args?.[2]);
          if (self.readFailures.has(fee)) throw new Error('rpc failure');
          return self.pools.get(fee)?.exists ? POOL : zeroAddress;
        }
        if (args.functionName === 'liquidity') {
          // The mock serves one pool address for all tiers, so liquidity is
          // resolved from whichever tier the test configured as non-empty.
          const entry = [...self.pools.values()].find((p) => p.exists);
          return entry?.liquidity ?? 0n;
        }
        throw new Error(`unexpected readContract: ${args.functionName}`);
      },
      async simulateContract(args: { args?: readonly unknown[] }) {
        const params = args.args?.[0] as { fee: number };
        self.quoterCalls.push(params.fee);
        const entry = self.pools.get(params.fee);
        if (!entry?.exists) throw new Error('pool does not exist');
        return { result: [entry.amountOut, 0n, 0, 84_758n] };
      },
    } as unknown as PublicClient;
  }
}

describe('quote retrieval (UniswapAdapter.getQuote)', () => {
  let rpc: MockRpc;
  let adapter: UniswapAdapter;

  const noopExecutor = {} as ExecutorContractClient;

  beforeEach(() => {
    rpc = new MockRpc();
    adapter = new UniswapAdapter(config, noopExecutor, rpc.asClient());
  });

  it('returns a quote from a funded pool', async () => {
    rpc.setTier(3000, { amountOut: parseUnits('35', 6) });

    const quote = await adapter.getQuote({
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: parseUnits('0.01', 18),
    });

    expect(quote.amountOut).toBe(parseUnits('35', 6));
    expect(quote.poolFee).toBe(3000);
    expect(quote.tokenIn).toBe(WETH);
    expect(quote.gasEstimate).toBe(84_758n);
  });

  it('probes every configured fee tier', async () => {
    rpc.setTier(500, { amountOut: parseUnits('30', 6) });
    rpc.setTier(3000, { amountOut: parseUnits('35', 6) });
    rpc.setTier(10000, { amountOut: parseUnits('33', 6) });

    await adapter.getQuote({ tokenIn: WETH, tokenOut: USDC, amountIn: parseUnits('0.01', 18) });

    // Numeric comparator: the default sort is lexicographic, which would put
    // 10000 before 3000.
    expect(rpc.quoterCalls.sort((a, b) => a - b)).toEqual([500, 3000, 10000]);
  });

  it('selects the tier with the best output', async () => {
    // Hardcoding one tier would silently take a worse price, or report "no
    // liquidity" while a good pool sits next door.
    rpc.setTier(500, { amountOut: parseUnits('30', 6) });
    rpc.setTier(3000, { amountOut: parseUnits('35', 6) });
    rpc.setTier(10000, { amountOut: parseUnits('41', 6) });

    const quote = await adapter.getQuote({
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: parseUnits('0.01', 18),
    });

    expect(quote.poolFee).toBe(10000);
    expect(quote.amountOut).toBe(parseUnits('41', 6));
  });

  it('skips tiers whose pool does not exist', async () => {
    rpc.setTier(500, { exists: false });
    rpc.setTier(3000, { amountOut: parseUnits('35', 6) });

    const quote = await adapter.getQuote({
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: parseUnits('0.01', 18),
    });

    expect(quote.poolFee).toBe(3000);
    // Never quoted the missing pool: QuoterV2 reverts on those, and a revert is
    // far more expensive to interpret than a existence check.
    expect(rpc.quoterCalls).not.toContain(500);
  });

  it('skips pools that exist but hold no liquidity', async () => {
    rpc.setTier(3000, { liquidity: 0n });

    await expect(
      adapter.getQuote({ tokenIn: WETH, tokenOut: USDC, amountIn: parseUnits('0.01', 18) }),
    ).rejects.toThrow(NoLiquidityError);
  });

  it('throws NoLiquidityError when no tier is usable', async () => {
    await expect(
      adapter.getQuote({ tokenIn: WETH, tokenOut: USDC, amountIn: parseUnits('0.01', 18) }),
    ).rejects.toThrow(NoLiquidityError);
  });

  it('survives one tier failing at the RPC level', async () => {
    // A single flaky tier must not fail the whole quote.
    rpc.setTier(500, { amountOut: parseUnits('30', 6) });
    rpc.setTier(3000, { amountOut: parseUnits('35', 6) });
    rpc.readFailures.add(500);

    const quote = await adapter.getQuote({
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: parseUnits('0.01', 18),
    });

    expect(quote.poolFee).toBe(3000);
  });

  it('stamps the quote with a fetch time so staleness is detectable', async () => {
    rpc.setTier(3000, {});
    const before = Date.now();

    const quote = await adapter.getQuote({
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: parseUnits('0.01', 18),
    });

    expect(quote.quotedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does not cache — every call hits the venue again', async () => {
    // The whole hazard fresh quoting guards against is acting on a price that
    // was true earlier.
    rpc.setTier(3000, { amountOut: parseUnits('35', 6) });
    await adapter.getQuote({ tokenIn: WETH, tokenOut: USDC, amountIn: parseUnits('0.01', 18) });

    rpc.setTier(3000, { amountOut: parseUnits('20', 6) });
    const second = await adapter.getQuote({
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: parseUnits('0.01', 18),
    });

    expect(second.amountOut).toBe(parseUnits('20', 6));
  });
});
