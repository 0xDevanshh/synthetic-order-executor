import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem';

import { quoterV2Abi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from '../abi/quoterV2.js';
import { createReadClient } from '../clients.js';
import type { ChainConfig } from '../config.js';
import type { ExecutorContractClient } from '../contract/executorClient.js';
import {
  NoLiquidityError,
  QuoteStaleError,
  type BuildParamsInput,
  type DexAdapter,
  type DexQuote,
  type ExecutionParams,
  type ExecutionReceipt,
  type QuoteRequest,
} from './DexAdapter.js';

const BPS = 10_000n;

/** A quote older than this is refused rather than acted on. */
export const MAX_QUOTE_AGE_MS = 30_000;

/**
 * Uniswap V3 implementation of DexAdapter.
 *
 * This is the ONLY file in the codebase that knows what a fee tier is, or that
 * QuoterV2 exists. Everything above it sees `getQuote`, `buildExecutionParams`
 * and `execute`.
 *
 * Settlement goes through SyntheticOrderExecutor, never straight to the router.
 * The adapter therefore cannot bypass the allowlist, the size cap, the deadline
 * or the replay guard — those hold even if this code is wrong or malicious,
 * which is the entire point of putting them on-chain.
 */
export class UniswapAdapter implements DexAdapter {
  readonly name = 'uniswap-v3';

  private readonly read: PublicClient;

  constructor(
    private readonly config: ChainConfig,
    private readonly executor: ExecutorContractClient,
    readClient?: PublicClient,
  ) {
    this.read = readClient ?? createReadClient(config);
  }

  /**
   * Fetch a FRESH quote, probing every configured fee tier and taking the best.
   *
   * Nothing is cached, deliberately. The whole hazard this guards against is
   * executing against a price that was true when the order was created — the
   * market has moved since, possibly a great deal.
   *
   * Hardcoding a single tier would be wrong too: Sepolia liquidity is spread
   * unevenly across 0.05% / 0.3% / 1%, and picking the wrong one produces a
   * spurious "no liquidity" failure while a perfectly good pool sits next door.
   */
  async getQuote(request: QuoteRequest): Promise<DexQuote> {
    const quotes = await Promise.all(
      this.config.feeTiers.map((fee) => this.quoteTier(request, fee)),
    );

    const usable = quotes.filter((q): q is DexQuote => q !== undefined && q.amountOut > 0n);
    if (usable.length === 0) {
      throw new NoLiquidityError(request.tokenIn, request.tokenOut);
    }

    return usable.reduce((best, q) => (q.amountOut > best.amountOut ? q : best));
  }

  private async quoteTier(
    request: QuoteRequest,
    fee: number,
  ): Promise<DexQuote | undefined> {
    try {
      // Skip tiers with no pool or no liquidity before quoting: QuoterV2 reverts
      // on those, and a revert is far more expensive to interpret than a check.
      const pool = await this.read.readContract({
        address: this.config.factory,
        abi: uniswapV3FactoryAbi,
        functionName: 'getPool',
        args: [request.tokenIn, request.tokenOut, fee],
      });

      if (pool === zeroAddress) return undefined;

      const liquidity = await this.read.readContract({
        address: pool,
        abi: uniswapV3PoolAbi,
        functionName: 'liquidity',
      });

      if (liquidity === 0n) return undefined;

      // QuoterV2 is state-mutating by design — it swaps, reverts, and encodes
      // the answer in the revert data. simulateContract, never readContract.
      const { result } = await this.read.simulateContract({
        address: this.config.quoterV2,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: request.tokenIn,
            tokenOut: request.tokenOut,
            amountIn: request.amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const [amountOut, , , gasEstimate] = result;

      return {
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amountIn,
        amountOut,
        poolFee: fee,
        gasEstimate,
        quotedAt: new Date(),
      };
    } catch {
      // One dead tier must not fail the whole quote — the other tiers may be
      // perfectly usable.
      return undefined;
    }
  }

  /**
   * Derive contract arguments from a fresh quote.
   *
   *   minAmountOut = quotedOut * (10_000 - slippageBps) / 10_000
   *
   * Integer arithmetic on base units throughout. The contract enforces
   * `amountOut >= minAmountOut` strictly, so a rounding artefact here is a
   * revert, not a rounding artefact.
   *
   * Refuses a stale quote outright. Accepting one would reintroduce exactly the
   * hazard fresh quoting exists to remove.
   */
  buildExecutionParams(input: BuildParamsInput): ExecutionParams {
    const { quote, executionId, owner } = input;

    const ageMs = Date.now() - quote.quotedAt.getTime();
    if (ageMs > MAX_QUOTE_AGE_MS) throw new QuoteStaleError(ageMs, MAX_QUOTE_AGE_MS);

    const minAmountOut =
      (quote.amountOut * (BPS - BigInt(this.config.slippageBps))) / BPS;

    const deadline =
      BigInt(Math.floor(Date.now() / 1000)) + BigInt(this.config.deadlineWindowSec);

    return {
      executionId,
      owner,
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      poolFee: quote.poolFee,
      amountIn: quote.amountIn,
      minAmountOut,
      deadline,
    };
  }

  /** Submit through SyntheticOrderExecutor. */
  async execute(
    params: ExecutionParams,
    onSubmitted?: (txHash: Hex) => Promise<void>,
  ): Promise<ExecutionReceipt> {
    return this.executor.execute(params, onSubmitted);
  }

  /** Convenience for diagnostics and the Sepolia verification script. */
  async hasLiquidity(tokenIn: Address, tokenOut: Address, fee: number): Promise<boolean> {
    const quote = await this.quoteTier({ tokenIn, tokenOut, amountIn: 1n }, fee);
    return quote !== undefined;
  }
}
