import { describe, expect, it } from 'vitest';
import type { OrderStatus } from '@soe/database';

import {
  ALLOWED_TRANSITIONS,
  canTransition,
  isTerminal,
  isUserCancellable,
} from '../src/domain/orderStatus.js';

const ALL: OrderStatus[] = [
  'PENDING',
  'TRIGGERED',
  'EXECUTING',
  'EXECUTED',
  'FAILED',
  'CANCELLED',
];

describe('order state machine', () => {
  it('allows exactly the documented transitions and nothing else', () => {
    // Exhaustive over the full from x to matrix. Cheap, and the single best
    // defence against a stray status write appearing somewhere later.
    for (const from of ALL) {
      for (const to of ALL) {
        const expected = ALLOWED_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('allows PENDING -> TRIGGERED and PENDING -> CANCELLED', () => {
    expect(canTransition('PENDING', 'TRIGGERED')).toBe(true);
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
  });

  it('allows TRIGGERED -> EXECUTING, CANCELLED and FAILED', () => {
    expect(canTransition('TRIGGERED', 'EXECUTING')).toBe(true);
    expect(canTransition('TRIGGERED', 'CANCELLED')).toBe(true);
    expect(canTransition('TRIGGERED', 'FAILED')).toBe(true);
  });

  it('allows EXECUTING -> EXECUTED and FAILED only', () => {
    expect(canTransition('EXECUTING', 'EXECUTED')).toBe(true);
    expect(canTransition('EXECUTING', 'FAILED')).toBe(true);
    // Cancelling a claimed order would let the database claim an order is dead
    // while a transaction for it is still in the mempool.
    expect(canTransition('EXECUTING', 'CANCELLED')).toBe(false);
  });

  it('makes EXECUTED and CANCELLED terminal', () => {
    for (const to of ALL) {
      expect(canTransition('EXECUTED', to)).toBe(false);
      expect(canTransition('CANCELLED', to)).toBe(false);
    }
    expect(isTerminal('EXECUTED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(false);
  });

  it('allows FAILED -> TRIGGERED for the retry path', () => {
    expect(canTransition('FAILED', 'TRIGGERED')).toBe(true);
    expect(canTransition('FAILED', 'EXECUTING')).toBe(false);
  });

  it('rejects skipping the machine entirely', () => {
    expect(canTransition('PENDING', 'EXECUTED')).toBe(false);
    expect(canTransition('PENDING', 'EXECUTING')).toBe(false);
  });

  it('marks only PENDING and TRIGGERED as user-cancellable', () => {
    expect(isUserCancellable('PENDING')).toBe(true);
    expect(isUserCancellable('TRIGGERED')).toBe(true);
    expect(isUserCancellable('EXECUTING')).toBe(false);
    expect(isUserCancellable('EXECUTED')).toBe(false);
    expect(isUserCancellable('FAILED')).toBe(false);
    expect(isUserCancellable('CANCELLED')).toBe(false);
  });
});
