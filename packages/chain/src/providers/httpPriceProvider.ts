import { PriceSourceName, type PriceProvider } from '@soe/shared';

/**
 * Secondary price source (CoinGecko or equivalent).
 *
 * Cross-check only. It never fires a trigger on its own — it exists so that a
 * wedged or manipulated primary oracle shows up as a divergence beyond
 * MAX_PRICE_DIVERGENCE_BPS, which marks the primary tick suspect.
 */
export const httpPriceProvider: PriceProvider = {
  name: PriceSourceName.COINGECKO,
  isPrimary: false,

  async getPrice() {
    // TODO(impl): fetch PRICE_FALLBACK_URL with a timeout, parse defensively,
    //             never throw into the poll loop.
    throw new Error('TODO: implement http getPrice');
  },

  supports(pair: string) {
    return pair === 'ETH/USD';
  },
};
