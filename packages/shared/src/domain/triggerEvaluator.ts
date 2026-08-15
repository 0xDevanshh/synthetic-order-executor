import type { OrderTrigger } from '../types/order.js';
import type { PriceTick } from '../types/priceProvider.js';

/**
 * Decides whether a price tick satisfies a trigger. Pure — no I/O, no clock.
 *
 * Two rules that are easy to get wrong and are unit-tested at the boundary:
 *   1. A suspect tick NEVER fires a trigger, regardless of price.
 *   2. Comparison is inclusive. "Sell when ETH <= $3500" fires at exactly
 *      $3500.00, matching what the user reads in the UI.
 */
export function isTriggered(_trigger: OrderTrigger, _tick: PriceTick): boolean {
  // TODO(impl): return false if tick.suspect or pair mismatch; otherwise
  //             compare with a fixed-point decimal (never parseFloat).
  throw new Error('TODO: implement isTriggered');
}
