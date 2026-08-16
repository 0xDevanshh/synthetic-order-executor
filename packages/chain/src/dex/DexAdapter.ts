import type { Address, Hex } from 'viem';

/** A quote taken from a DEX at a specific moment. */
export interface DexQuote {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Expected output in base units, from the venue's own pricing maths. */
  amountOut: bigint;
  /** Venue-specific route hint. For Uniswap V3 this is the fee tier. */
  poolFee: number;
  gasEstimate: bigint;
  /**
   * When the quote was taken. Quotes decay fast; the execution path checks this
   * and refuses to act on a stale one rather than trusting the number blindly.
   */
  quotedAt: Date;
}

export interface QuoteRequest {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}

/** Concrete arguments for one SyntheticOrderExecutor.executeSwap call. */
export interface ExecutionParams {
  executionId: Hex;
  owner: Address;
  tokenIn: Address;
  tokenOut: Address;
  poolFee: number;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
}

export interface BuildParamsInput {
  executionId: Hex;
  owner: Address;
  quote: DexQuote;
}

/**
 * The venue abstraction.
 *
 * Everything above this interface — the execution service, the worker, the
 * order pipeline — depends only on these three methods. Nothing outside
 * `uniswapAdapter.ts` may import a fee tier, a router ABI, or a QuoterV2 type,
 * so adding a second venue is an additive change rather than a rewrite.
 *
 * Note `execute` goes through SyntheticOrderExecutor, never directly to the
 * router. That is what keeps the on-chain restrictions unbypassable: the adapter
 * cannot route around the allowlist, the size cap or the replay guard even if
 * it wanted to.
 */
export interface DexAdapter {
  readonly name: string;

  /**
   * A FRESH quote. Implementations must not cache: an order executes against
   * the market as it is at submission, not as it was when the order was placed.
   */
  getQuote(request: QuoteRequest): Promise<DexQuote>;

  /**
   * Turn a quote into contract arguments, applying slippage and a deadline.
   * Pure and synchronous, so the arithmetic is directly testable.
   */
  buildExecutionParams(input: BuildParamsInput): ExecutionParams;

  /**
   * Sign and broadcast. Returns the transaction hash WITHOUT waiting for a
   * receipt — resolving the outcome is the transaction monitor's job.
   *
   * `onSigned` fires with the hash BEFORE the transaction is broadcast; see the
   * implementation for why that ordering is load-bearing.
   */
  submit(params: ExecutionParams, onSigned?: (txHash: Hex) => Promise<void>): Promise<Hex>;
}

export class NoLiquidityError extends Error {
  constructor(tokenIn: Address, tokenOut: Address) {
    super(`No usable liquidity for ${tokenIn} -> ${tokenOut} on any configured fee tier`);
    this.name = 'NoLiquidityError';
  }
}

export class QuoteStaleError extends Error {
  constructor(ageMs: number, maxAgeMs: number) {
    super(`Quote is ${ageMs}ms old, exceeding the ${maxAgeMs}ms limit`);
    this.name = 'QuoteStaleError';
  }
}

export class NoSignerError extends Error {
  constructor() {
    super('No executor key configured; this process cannot submit transactions');
    this.name = 'NoSignerError';
  }
}
