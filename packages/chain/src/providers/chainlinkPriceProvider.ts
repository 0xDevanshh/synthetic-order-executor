import { PriceSourceName, type PriceProvider } from '@soe/shared';

/**
 * Primary price source: Chainlink ETH/USD on Sepolia.
 *
 * `latestRoundData` is only trustworthy with both guards applied:
 *   - `updatedAt` newer than MAX_PRICE_STALENESS_SEC  (feed not wedged)
 *   - `answeredInRound >= roundId`                    (round actually complete)
 * A tick failing either is marked suspect and can never fire a trigger.
 */
export const chainlinkPriceProvider: PriceProvider = {
  name: PriceSourceName.CHAINLINK,
  isPrimary: true,

  async getPrice() {
    // TODO(impl): read latestRoundData + decimals, scale to a decimal string,
    //             apply both guards, return the PriceTick.
    throw new Error('TODO: implement chainlink getPrice');
  },

  supports(pair: string) {
    return pair === 'ETH/USD';
  },
};
