import { Prisma, type OrderSide } from '@soe/database';

/**
 * Does the current market price satisfy an order's trigger condition?
 *
 * Pure: no I/O, no clock, no database. This is the single definition of "should
 * this order fire", and it is what the unit suite hammers at the boundary.
 *
 *   SELL fires when price <= triggerPrice   ("sell if it drops to 3500")
 *   BUY  fires when price >= triggerPrice   ("buy if it rises to 3500")
 *
 * Comparison is INCLUSIVE. A user reading "sell at 3500" expects a fill at
 * exactly 3500, not a silent miss because the market printed the threshold
 * precisely.
 *
 * Both sides are compared as arbitrary-precision decimals, never as JS numbers.
 * `3500.1 - 3500` in floating point is not zero, and this comparison decides
 * whether real funds move.
 */
export function isTriggered(
  side: OrderSide,
  triggerPrice: Prisma.Decimal | string,
  currentPrice: Prisma.Decimal | string,
): boolean {
  const trigger = new Prisma.Decimal(triggerPrice.toString());
  const price = new Prisma.Decimal(currentPrice.toString());

  return side === 'SELL' ? price.lessThanOrEqualTo(trigger) : price.greaterThanOrEqualTo(trigger);
}
