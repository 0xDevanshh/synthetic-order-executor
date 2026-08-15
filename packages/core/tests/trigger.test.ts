import { describe, expect, it } from 'vitest';
import { Prisma } from '@soe/database';

import { isTriggered } from '../src/domain/trigger.js';

describe('isTriggered', () => {
  describe('SELL — fires when the market falls to the trigger', () => {
    it('fires below the trigger (the worked example: 3490 <= 3500)', () => {
      expect(isTriggered('SELL', '3500', '3490')).toBe(true);
    });

    it('does NOT fire above the trigger (3600 > 3500)', () => {
      expect(isTriggered('SELL', '3500', '3600')).toBe(false);
    });

    it('fires at exactly the trigger price', () => {
      // Inclusive on purpose. A user reading "sell at 3500" expects a fill when
      // the market prints 3500, not a silent miss.
      expect(isTriggered('SELL', '3500', '3500')).toBe(true);
    });

    it('does not fire one cent above', () => {
      expect(isTriggered('SELL', '3500', '3500.01')).toBe(false);
    });

    it('fires one cent below', () => {
      expect(isTriggered('SELL', '3500', '3499.99')).toBe(true);
    });
  });

  describe('BUY — fires when the market rises to the trigger', () => {
    it('fires above the trigger', () => {
      expect(isTriggered('BUY', '3500', '3600')).toBe(true);
    });

    it('does not fire below the trigger', () => {
      expect(isTriggered('BUY', '3500', '3490')).toBe(false);
    });

    it('fires at exactly the trigger price', () => {
      expect(isTriggered('BUY', '3500', '3500')).toBe(true);
    });
  });

  describe('precision', () => {
    it('compares as exact decimals, not floats', () => {
      // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. If this comparison ever
      // moves to Number, this case flips and an order fires (or does not) on a
      // rounding artefact.
      expect(isTriggered('SELL', '0.3', '0.30000000000000004')).toBe(false);
      expect(isTriggered('SELL', '0.30000000000000004', '0.3')).toBe(true);
    });

    it('handles 18-decimal precision without loss', () => {
      const trigger = '3500.000000000000000001';
      expect(isTriggered('SELL', trigger, '3500.000000000000000000')).toBe(true);
      expect(isTriggered('SELL', trigger, '3500.000000000000000002')).toBe(false);
    });

    it('handles very large prices', () => {
      expect(isTriggered('BUY', '1000000000', '1000000001')).toBe(true);
    });

    it('accepts Prisma.Decimal as well as strings', () => {
      expect(isTriggered('SELL', new Prisma.Decimal('3500'), new Prisma.Decimal('3490'))).toBe(
        true,
      );
    });
  });
});
