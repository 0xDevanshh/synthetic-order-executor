import { Prisma } from '@soe/database';

import {
  PriceUnavailableError,
  PriceUntrustedError,
  type PriceProvider,
  type PriceQuote,
} from './PriceProvider.js';

export interface PriceServiceOptions {
  /** Reject a price older than this. */
  maxStalenessSec?: number;
  /** Reject when primary and cross-check disagree by more than this, in bps. */
  maxDivergenceBps?: number;
}

/**
 * Aggregates providers and decides whether a price is safe to ACT on.
 *
 * The distinction that matters: a provider answers "what is the price"; this
 * service answers "should we move money based on it". Those are different
 * questions, and conflating them is how a wedged oracle quietly triggers a book
 * of orders.
 *
 * Two guards:
 *
 *   1. Staleness — a price older than maxStalenessSec is refused outright.
 *   2. Divergence — when a cross-check provider is configured, the two must
 *      agree within maxDivergenceBps. Disagreement means at least one is wrong
 *      and we cannot tell which, so the tick is refused rather than guessed at.
 *
 * Refusing is always safe here: an order that does not fire this tick fires on
 * the next one. An order that fires on a bad price cannot be un-fired.
 */
export class PriceService {
  private readonly maxStalenessSec: number;
  private readonly maxDivergenceBps: number;

  constructor(
    private readonly primary: PriceProvider,
    private readonly crossCheck?: PriceProvider,
    options: PriceServiceOptions = {},
  ) {
    this.maxStalenessSec = options.maxStalenessSec ?? 3_600;
    this.maxDivergenceBps = options.maxDivergenceBps ?? 200;
  }

  /**
   * A validated price, or a throw. Never returns a price it does not trust.
   */
  async getValidatedPrice(asset: string): Promise<PriceQuote> {
    const quote = await this.primary.getPrice(asset);

    const ageSec = (Date.now() - quote.observedAt.getTime()) / 1000;
    if (ageSec > this.maxStalenessSec) {
      throw new PriceUntrustedError(`primary price is ${Math.round(ageSec)}s stale`, {
        source: quote.source,
        maxStalenessSec: this.maxStalenessSec,
      });
    }

    if (this.crossCheck && this.crossCheck.supports(asset)) {
      await this.assertAgreement(asset, quote);
    }

    return quote;
  }

  private async assertAgreement(asset: string, primary: PriceQuote): Promise<void> {
    let secondary: PriceQuote;
    try {
      secondary = await this.crossCheck!.getPrice(asset);
    } catch (error) {
      // A cross-check that is merely DOWN must not halt trading — that would
      // make the optional guard a hard dependency and reduce availability
      // rather than increase safety. A cross-check that DISAGREES is different,
      // and is handled below.
      if (error instanceof PriceUnavailableError) return;
      throw error;
    }

    const a = new Prisma.Decimal(primary.price);
    const b = new Prisma.Decimal(secondary.price);
    if (a.isZero()) throw new PriceUntrustedError('primary price is zero');

    const divergenceBps = a.minus(b).abs().dividedBy(a).times(10_000);

    if (divergenceBps.greaterThan(this.maxDivergenceBps)) {
      throw new PriceUntrustedError(
        `sources diverge by ${divergenceBps.toFixed(0)}bps (max ${this.maxDivergenceBps})`,
        {
          primary: { source: primary.source, price: primary.price },
          secondary: { source: secondary.source, price: secondary.price },
        },
      );
    }
  }
}
