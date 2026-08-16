import { ChainlinkPriceProvider } from './chainlink.provider.js';
import { CoinGeckoPriceProvider } from './coingecko.provider.js';
import { StaticPriceProvider } from './static.provider.js';
import { PriceService } from './price.service.js';
import type { PriceProvider } from './PriceProvider.js';

export type PriceProviderKind = 'chainlink' | 'coingecko' | 'static';

export interface PriceProviderConfig {
  provider: PriceProviderKind;
  crossCheck?: PriceProviderKind | 'none';
  staticPrice?: string;
  rpcUrl?: string;
  chainlinkFeed?: `0x${string}`;
  maxStalenessSec?: number;
  maxDivergenceBps?: number;
}

/**
 * The ONLY place that names a concrete provider.
 *
 * Everything downstream depends on the PriceProvider interface, so switching to
 * Pyth or a vendor feed means adding a class here and a value to the union —
 * and nothing else in the system changes.
 */
export function buildPriceProvider(
  kind: PriceProviderKind,
  config: PriceProviderConfig,
): PriceProvider {
  switch (kind) {
    case 'chainlink':
      if (!config.rpcUrl) throw new Error('chainlink price provider requires an RPC url');
      return new ChainlinkPriceProvider(
        config.chainlinkFeed ?? '0x694AA1769357215DE4FAC081bf1f309aDC325306',
        [config.rpcUrl],
        config.maxStalenessSec ?? 3_600,
      );
    case 'coingecko':
      return new CoinGeckoPriceProvider();
    case 'static':
      return new StaticPriceProvider(config.staticPrice ?? '3500');
  }
}

export function buildPriceService(config: PriceProviderConfig): PriceService {
  const primary = buildPriceProvider(config.provider, config);

  const crossCheck =
    config.crossCheck && config.crossCheck !== 'none' && config.crossCheck !== config.provider
      ? buildPriceProvider(config.crossCheck, config)
      : undefined;

  return new PriceService(primary, crossCheck, {
    maxStalenessSec: config.maxStalenessSec,
    maxDivergenceBps: config.maxDivergenceBps,
  });
}
