import { PriceUnavailableError, type PriceProvider, type PriceQuote } from './PriceProvider.js';

const ASSET_IDS: Record<string, string> = {
  'ETH/USD': 'ethereum',
};

/**
 * CoinGecko spot price. The default DEVELOPMENT provider.
 *
 * Chosen for development because it is free, needs no key, and returns a real
 * market price — so a demo behaves like the real thing rather than against a
 * hardcoded constant.
 *
 * ---------------------------------------------------------------------------
 * NOT SUITABLE FOR PRODUCTION, and worth being precise about why:
 *
 *   - Single source. No cross-check, so a wrong or manipulated value is
 *     indistinguishable from a correct one.
 *   - No provenance. The response carries no signature and no round metadata;
 *     there is nothing to verify and nothing to audit after the fact.
 *   - No real staleness signal. The API does not report when the price was
 *     determined, only what it currently returns, so `observedAt` is fetch time
 *     and a frozen upstream feed looks perfectly fresh.
 *   - Aggressive public rate limits, and no availability guarantee.
 *
 * Production infrastructure of the kind PulsarX-style systems run would instead
 * use: a low-latency market-data feed with signed updates (Pyth, Chainlink Data
 * Streams, or a direct exchange feed), multiple independent sources with
 * median/quorum aggregation, explicit staleness and confidence-interval
 * handling, per-venue depth awareness so the trigger price reflects executable
 * liquidity rather than a mid-price, and circuit breakers on sudden divergence.
 *
 * The point of the PriceProvider interface is that adopting any of those is a
 * configuration change here, not a change to the trigger engine.
 * ---------------------------------------------------------------------------
 */
export class CoinGeckoPriceProvider implements PriceProvider {
  readonly name = 'coingecko';

  constructor(
    private readonly baseUrl = 'https://api.coingecko.com/api/v3',
    private readonly timeoutMs = 5_000,
  ) {}

  supports(asset: string): boolean {
    return asset in ASSET_IDS;
  }

  async getPrice(asset: string): Promise<PriceQuote> {
    const id = ASSET_IDS[asset];
    if (!id) throw new PriceUnavailableError(this.name, asset, 'unsupported asset');

    const url = `${this.baseUrl}/simple/price?ids=${id}&vs_currencies=usd`;

    // An unbounded fetch inside a repeatable job is how a worker wedges: the job
    // never settles, the scheduler stacks the next one, and the queue backs up.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new PriceUnavailableError(this.name, asset, `HTTP ${response.status}`);
      }

      const body = (await response.json()) as Record<string, { usd?: number }>;
      const value = body[id]?.usd;

      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new PriceUnavailableError(this.name, asset, `malformed payload`);
      }

      return {
        asset,
        // The API hands back a JSON number, so precision is already bounded by
        // what it chose to send. Converting to string here at least stops any
        // further float arithmetic downstream.
        price: value.toString(),
        source: this.name,
        observedAt: new Date(),
      };
    } catch (error) {
      if (error instanceof PriceUnavailableError) throw error;
      throw new PriceUnavailableError(
        this.name,
        asset,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
