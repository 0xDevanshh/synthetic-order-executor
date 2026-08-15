import type { Env } from '../config/env.js';
import { ChainlinkPriceProvider } from './chainlink.provider.js';
import { CoinGeckoPriceProvider } from './coingecko.provider.js';
import { StaticPriceProvider } from './static.provider.js';
import { PriceService } from './price.service.js';
import type { PriceProvider } from './PriceProvider.js';

/**
 * Builds the configured provider(s).
 *
 * This factory is the ONLY place that names a concrete provider. Everything
 * downstream — the engine, the worker, the tests — depends on the PriceProvider
 * interface, so switching to Pyth or a vendor feed means adding a class here and
 * a value to the enum, and nothing else changes.
 */
export function buildPriceProvider(env: Env, kind: string): PriceProvider {
  switch (kind) {
    case 'chainlink':
      return new ChainlinkPriceProvider(
        env.CHAINLINK_ETH_USD_FEED as `0x${string}`,
        [env.SEPOLIA_RPC_URL!],
        env.MAX_PRICE_STALENESS_SEC,
      );
    case 'coingecko':
      return new CoinGeckoPriceProvider();
    case 'static':
      return new StaticPriceProvider(env.STATIC_PRICE ?? '3500');
    default:
      throw new Error(`Unknown price provider: ${kind}`);
  }
}

export function buildPriceService(env: Env): PriceService {
  const primary = buildPriceProvider(env, env.PRICE_PROVIDER);

  const crossCheck =
    env.PRICE_CROSSCHECK_PROVIDER !== 'none' &&
    env.PRICE_CROSSCHECK_PROVIDER !== env.PRICE_PROVIDER
      ? buildPriceProvider(env, env.PRICE_CROSSCHECK_PROVIDER)
      : undefined;

  return new PriceService(primary, crossCheck, {
    maxStalenessSec: env.MAX_PRICE_STALENESS_SEC,
    maxDivergenceBps: env.MAX_PRICE_DIVERGENCE_BPS,
  });
}
