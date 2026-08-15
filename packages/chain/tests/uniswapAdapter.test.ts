import { describe, expect, it } from 'vitest';
import { parseUnits, getAddress } from 'viem';

import { UniswapAdapter, MAX_QUOTE_AGE_MS } from '../src/dex/uniswapAdapter.js';
import { QuoteStaleError, type DexQuote } from '../src/dex/DexAdapter.js';
import type { ChainConfig } from '../src/config.js';
import type { ExecutorContractClient } from '../src/contract/executorClient.js';

const WETH = getAddress('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');
const USDC = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
const OWNER = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');

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

/** Never called: buildExecutionParams is pure and makes no RPC calls. */
const noopExecutor = {} as ExecutorContractClient;
const noopClient = {} as never;

function quote(overrides: Partial<DexQuote> = {}): DexQuote {
  return {
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: parseUnits('0.01', 18),
    amountOut: parseUnits('35', 6),
    poolFee: 3000,
    gasEstimate: 150_000n,
    quotedAt: new Date(),
    ...overrides,
  };
}

describe('UniswapAdapter.buildExecutionParams', () => {
  const adapter = new UniswapAdapter(config, noopExecutor, noopClient);

  it('applies slippage to the quoted output', () => {
    // 35 USDC less 100bps = 34.65 USDC.
    const params = adapter.buildExecutionParams({
      executionId: `0x${'11'.repeat(32)}`,
      owner: OWNER,
      quote: quote(),
    });

    expect(params.minAmountOut).toBe(parseUnits('34.65', 6));
  });

  it('carries the quote fee tier through to the contract call', () => {
    const params = adapter.buildExecutionParams({
      executionId: `0x${'11'.repeat(32)}`,
      owner: OWNER,
      quote: quote({ poolFee: 500 }),
    });

    expect(params.poolFee).toBe(500);
  });

  it('computes in integer base units with no float drift', () => {
    // An awkward amount that a float would round. minAmountOut must be exact:
    // the contract enforces amountOut >= minAmountOut strictly.
    const params = adapter.buildExecutionParams({
      executionId: `0x${'11'.repeat(32)}`,
      owner: OWNER,
      quote: quote({ amountOut: 999_999_999n }),
    });

    expect(params.minAmountOut).toBe((999_999_999n * 9_900n) / 10_000n);
  });

  it('sets a deadline inside the configured window', () => {
    const params = adapter.buildExecutionParams({
      executionId: `0x${'11'.repeat(32)}`,
      owner: OWNER,
      quote: quote(),
    });

    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(params.deadline).toBeGreaterThan(now);
    expect(params.deadline).toBeLessThanOrEqual(now + BigInt(config.deadlineWindowSec) + 1n);
  });

  it('REFUSES a stale quote', () => {
    // The core safety rule: never act on an old quote. Accepting one would
    // reintroduce exactly the hazard fresh quoting exists to remove.
    expect(() =>
      adapter.buildExecutionParams({
        executionId: `0x${'11'.repeat(32)}`,
        owner: OWNER,
        quote: quote({ quotedAt: new Date(Date.now() - MAX_QUOTE_AGE_MS - 1_000) }),
      }),
    ).toThrow(QuoteStaleError);
  });

  it('accepts a quote just inside the freshness window', () => {
    expect(() =>
      adapter.buildExecutionParams({
        executionId: `0x${'11'.repeat(32)}`,
        owner: OWNER,
        quote: quote({ quotedAt: new Date(Date.now() - 1_000) }),
      }),
    ).not.toThrow();
  });

  it('never produces a minAmountOut above the quote', () => {
    for (const out of [1n, 1_000n, parseUnits('1000000', 6)]) {
      const params = adapter.buildExecutionParams({
        executionId: `0x${'11'.repeat(32)}`,
        owner: OWNER,
        quote: quote({ amountOut: out }),
      });
      expect(params.minAmountOut).toBeLessThanOrEqual(out);
    }
  });
});
