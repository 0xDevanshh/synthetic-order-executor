/**
 * A single observed price.
 *
 * `price` is a decimal string, never a JS number — a float here silently
 * corrupts trigger comparisons at the boundary, which is exactly where they
 * matter.
 */
export interface PriceTick {
  /** e.g. "ETH/USD". */
  pair: string;
  price: string;
  source: PriceSourceName;
  /** Oracle-reported update time, NOT when we polled. Drives staleness checks. */
  updatedAt: Date;
  observedAt: Date;
  /** Chainlink round id, when the source provides one. */
  roundId?: bigint;
  /**
   * True when the tick failed a sanity check (stale round, incomplete round, or
   * divergence from the cross-check source beyond MAX_PRICE_DIVERGENCE_BPS).
   * Suspect ticks are persisted for audit but MUST NEVER fire a trigger.
   */
  suspect: boolean;
  suspectReason?: string;
}

export const PriceSourceName = {
  CHAINLINK: 'chainlink',
  COINGECKO: 'coingecko',
} as const;
export type PriceSourceName = (typeof PriceSourceName)[keyof typeof PriceSourceName];

/**
 * Abstraction over a price feed.
 *
 * Two implementations: Chainlink on Sepolia (primary, on-chain, trust-minimised)
 * and an HTTP source (secondary, cross-check only). The secondary never fires a
 * trigger on its own — it exists to catch a wedged or manipulated oracle by
 * disagreeing with it.
 */
export interface PriceProvider {
  readonly name: PriceSourceName;
  readonly isPrimary: boolean;

  /** Latest price, with staleness and round-completeness already validated. */
  getPrice(pair: string): Promise<PriceTick>;

  supports(pair: string): boolean;
}

/** Aggregates providers and applies the cross-source divergence guard. */
export interface PriceService {
  /**
   * Primary price, marked `suspect` if it is stale, incomplete, or diverges
   * from the cross-check source beyond the configured tolerance.
   */
  getValidatedPrice(pair: string): Promise<PriceTick>;
}
