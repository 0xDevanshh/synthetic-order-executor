import type { Address } from 'viem';

/**
 * Result of an off-chain DEX quote.
 *
 * `amountOut` here is a *reference* only. It is never trusted as a settlement
 * guarantee — it feeds the slippage band, while the user's signed
 * `minAmountOut` is the actual protection.
 */
export interface DexQuote {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  /** Chosen V3 fee tier in hundredths of a bip: 500 = 0.05%. */
  poolFee: number;
  /** Estimated price impact in basis points, for UI display and sanity checks. */
  priceImpactBps: number;
  gasEstimate: bigint;
  /** When the quote was taken. Quotes go stale fast; the executor re-quotes. */
  quotedAt: Date;
}

export interface QuoteRequest {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Fee tiers to probe. Best amountOut wins. Defaults to [500, 3000, 10000]. */
  feeTiers?: number[];
}

/**
 * Abstraction over a DEX venue.
 *
 * Uniswap V3 is the only implementation for the MVP, but every consumer depends
 * on this interface rather than on Uniswap directly, so adding a second venue
 * (or a router aggregator) is an additive change rather than a rewrite.
 *
 * The adapter is strictly READ-ONLY. It never submits transactions — all
 * settlement goes through SyntheticOrderExecutor, which is what makes the
 * on-chain constraints unbypassable.
 */
export interface DexAdapter {
  readonly name: string;

  /** Best available quote across the probed fee tiers. */
  getQuote(request: QuoteRequest): Promise<DexQuote>;

  /** True if a pool exists at this fee tier with non-zero liquidity. */
  hasLiquidity(tokenIn: Address, tokenOut: Address, feeTier: number): Promise<boolean>;
}
