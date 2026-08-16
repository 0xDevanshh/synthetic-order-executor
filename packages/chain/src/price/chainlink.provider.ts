import { createPublicClient, fallback, formatUnits, http, type Address } from 'viem';
import { sepolia } from 'viem/chains';

import { PriceUnavailableError, type PriceProvider, type PriceQuote } from './PriceProvider.js';

/** Minimal AggregatorV3Interface surface. */
const aggregatorV3Abi = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

/**
 * Chainlink ETH/USD on Sepolia. The stronger of the two providers, and the one
 * to prefer when an RPC endpoint is configured.
 *
 * `latestRoundData` is only trustworthy with both guards applied:
 *
 *   - `updatedAt` newer than maxStalenessSec — a feed can wedge while still
 *     answering, and a stale answer that looks live is worse than no answer.
 *   - `answeredInRound >= roundId` — otherwise the round is still in progress
 *     and the answer is carried over from a previous one.
 *
 * Both are checked here rather than downstream, because a provider that can
 * detect its own bad data should never hand it on as if it were fine.
 *
 * Still not what production would use for triggering: a Sepolia feed updates on
 * heartbeat/deviation thresholds measured in minutes, which is far too coarse
 * for tight execution. See the note in coingecko.provider.ts.
 */
export class ChainlinkPriceProvider implements PriceProvider {
  readonly name = 'chainlink';

  private readonly client;
  private decimalsCache: number | undefined;

  constructor(
    private readonly feedAddress: Address,
    rpcUrls: string[],
    private readonly maxStalenessSec = 3_600,
  ) {
    this.client = createPublicClient({
      chain: sepolia,
      transport: fallback(rpcUrls.map((url) => http(url, { timeout: 10_000 }))),
    });
  }

  supports(asset: string): boolean {
    return asset === 'ETH/USD';
  }

  async getPrice(asset: string): Promise<PriceQuote> {
    if (!this.supports(asset)) {
      throw new PriceUnavailableError(this.name, asset, 'unsupported asset');
    }

    try {
      const [roundId, answer, , updatedAt, answeredInRound] = await this.client.readContract({
        address: this.feedAddress,
        abi: aggregatorV3Abi,
        functionName: 'latestRoundData',
      });

      if (answer <= 0n) {
        throw new PriceUnavailableError(this.name, asset, `non-positive answer ${answer}`);
      }

      if (answeredInRound < roundId) {
        throw new PriceUnavailableError(
          this.name,
          asset,
          `incomplete round (answeredInRound=${answeredInRound} < roundId=${roundId})`,
        );
      }

      const ageSec = Math.floor(Date.now() / 1000) - Number(updatedAt);
      if (ageSec > this.maxStalenessSec) {
        throw new PriceUnavailableError(
          this.name,
          asset,
          `stale by ${ageSec}s (max ${this.maxStalenessSec}s)`,
        );
      }

      const decimals = await this.getDecimals();

      return {
        asset,
        // formatUnits does exact integer -> decimal-string conversion. No float
        // ever touches this value.
        price: formatUnits(answer, decimals),
        source: this.name,
        observedAt: new Date(Number(updatedAt) * 1000),
        roundId,
      };
    } catch (error) {
      if (error instanceof PriceUnavailableError) throw error;
      throw new PriceUnavailableError(
        this.name,
        asset,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async getDecimals(): Promise<number> {
    if (this.decimalsCache === undefined) {
      this.decimalsCache = await this.client.readContract({
        address: this.feedAddress,
        abi: aggregatorV3Abi,
        functionName: 'decimals',
      });
    }
    return this.decimalsCache;
  }
}
