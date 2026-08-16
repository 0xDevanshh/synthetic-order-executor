import { Router, type Router as ExpressRouter } from 'express';
import { buildPriceService, type PriceService } from '@soe/chain';

import { loadEnv } from '../../config/env.js';

/**
 * GET /api/prices/:pair  ->  { pair, price, source, observedAt, ageSeconds }
 *
 * Serves the same PriceService the worker uses, so the number the UI shows and
 * the number the trigger engine acts on come from one implementation. A second
 * price path here would eventually disagree with the engine, and users would be
 * told their order "should have fired".
 *
 * Cached briefly: the UI polls, and the free CoinGecko tier rate-limits hard.
 */
let service: PriceService | undefined;
let cache: { value: unknown; at: number } | undefined;

const CACHE_TTL_MS = 5_000;

function getService(): PriceService {
  if (!service) {
    const env = loadEnv();
    service = buildPriceService({
      provider: env.PRICE_PROVIDER,
      crossCheck: 'none',
      staticPrice: env.STATIC_PRICE,
      rpcUrl: env.SEPOLIA_RPC_URL,
      maxStalenessSec: 3_600,
    });
  }
  return service;
}

export const priceRoutes: ExpressRouter = Router();

priceRoutes.get('/:pair', async (req, res, next) => {
  try {
    const pair = decodeURIComponent(req.params.pair ?? 'ETH/USD').toUpperCase();

    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      res.json({ data: cache.value });
      return;
    }

    const quote = await getService().getValidatedPrice(pair);

    const value = {
      pair: quote.asset,
      price: quote.price,
      source: quote.source,
      observedAt: quote.observedAt.toISOString(),
      ageSeconds: Math.max(0, Math.round((Date.now() - quote.observedAt.getTime()) / 1000)),
    };

    cache = { value, at: Date.now() };
    res.json({ data: value });
  } catch (error) {
    // A price that cannot be trusted is a 503, not a 500: the service is fine,
    // the upstream feed is not, and the UI should say so rather than showing a
    // stale number as if it were live.
    res.status(503).json({
      error: {
        code: 'PRICE_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'price unavailable',
      },
    });
    void next;
  }
});
