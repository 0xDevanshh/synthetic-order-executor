/**
 * A single observed price.
 *
 * `price` is a decimal STRING, never a JS number. Trigger comparison decides
 * whether real funds move, and it happens at an exact boundary — a float here
 * silently corrupts the one comparison that matters.
 */
export interface PriceQuote {
  /** e.g. "ETH/USD". */
  asset: string;
  price: string;
  source: string;
  /**
   * When the SOURCE says the price was determined, which is not when we fetched
   * it. Chainlink reports this directly; HTTP sources usually do not, in which
   * case it is the fetch time and staleness detection is correspondingly weaker.
   */
  observedAt: Date;
  /** Round id, where the source has such a concept. */
  roundId?: bigint;
}

/**
 * The abstraction the trigger engine depends on.
 *
 * The engine must never import a specific provider. Swapping Chainlink for
 * Pyth, a market-data vendor, or an internal aggregator has to be a
 * configuration change, not a rewrite of the business logic — which is the whole
 * reason this interface exists rather than a direct API call inside the worker.
 */
export interface PriceProvider {
  readonly name: string;

  /**
   * Current price for an asset pair.
   * @throws if the price cannot be obtained or fails the provider's own checks.
   */
  getPrice(asset: string): Promise<PriceQuote>;

  supports(asset: string): boolean;
}

/** Thrown when a provider cannot produce a usable price. */
export class PriceUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly asset: string,
    reason: string,
  ) {
    super(`[${provider}] price unavailable for ${asset}: ${reason}`);
    this.name = 'PriceUnavailableError';
  }
}

/** Thrown when a price is obtainable but not trustworthy enough to act on. */
export class PriceUntrustedError extends Error {
  constructor(reason: string, readonly details?: Record<string, unknown>) {
    super(`price failed validation: ${reason}`);
    this.name = 'PriceUntrustedError';
  }
}
