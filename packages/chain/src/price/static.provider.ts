import { PriceUnavailableError, type PriceProvider, type PriceQuote } from './PriceProvider.js';

/**
 * A price you set by hand.
 *
 * Two legitimate uses:
 *   - Unit tests, where a deterministic price is the point.
 *   - Local demos, where you want to drive an order across its trigger on
 *     command instead of waiting for the market to move.
 *
 * Enabled only via PRICE_PROVIDER=static. The worker refuses to select it when
 * NODE_ENV=production, because a synthetic order engine trading against a
 * hardcoded price is the single most dangerous misconfiguration in this system.
 */
export class StaticPriceProvider implements PriceProvider {
  readonly name = 'static';

  constructor(private price: string = '3500') {}

  setPrice(price: string): void {
    this.price = price;
  }

  supports(): boolean {
    return true;
  }

  async getPrice(asset: string): Promise<PriceQuote> {
    if (!this.price) throw new PriceUnavailableError(this.name, asset, 'no price configured');

    return {
      asset,
      price: this.price,
      source: this.name,
      observedAt: new Date(),
    };
  }
}
