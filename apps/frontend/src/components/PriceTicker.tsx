'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { api, type PriceQuote } from '@/lib/api';

/**
 * Current ETH/USD, polled from the same PriceService the trigger engine uses.
 *
 * Surfaces `source` and tick age deliberately: if the feed is stale or down, the
 * user should be able to see why their order is not firing rather than assume
 * the system is broken.
 */
export function PriceTicker() {
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const next = await api.getPrice('ETH/USD');
        if (!active) return;
        setQuote(next);
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'price unavailable');
      }
    };

    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <Card>
      <CardContent className="flex items-baseline justify-between p-4">
        <div>
          <div className="text-xs text-muted-foreground">ETH / USD</div>
          <div className="text-2xl font-semibold tabular-nums">
            {quote ? `$${Number(quote.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : quote ? (
            <>
              <div>source: {quote.source}</div>
              <div>{quote.ageSeconds}s ago</div>
            </>
          ) : (
            <span>loading…</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
