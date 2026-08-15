import { describe, it } from 'vitest';

/**
 * Walks the full from x to matrix, legal and illegal. Cheap, pure, and the
 * single best defence against a stray status write somewhere in the workers.
 */
describe('orderStateMachine', () => {
  it('allows PENDING -> TRIGGERED and PENDING -> CANCELLED');
  it('allows TRIGGERED -> EXECUTING, CANCELLED, FAILED');
  it('allows EXECUTING -> EXECUTED and EXECUTING -> FAILED only');
  it('rejects EXECUTING -> CANCELLED — a claimed order cannot be cancelled off-chain');
  it('rejects every transition out of EXECUTED and CANCELLED');
  it('allows FAILED -> TRIGGERED for the retry path');
  it('rejects PENDING -> EXECUTED, skipping the machine entirely');
});

describe('triggerEvaluator', () => {
  it('fires PRICE_BELOW at exactly the trigger price (inclusive)');
  it('does not fire PRICE_BELOW one wei above the trigger');
  it('never fires on a suspect tick, whatever the price');
  it('ignores ticks for a different pair');
  it('compares as fixed-point decimals, not floats');
});
