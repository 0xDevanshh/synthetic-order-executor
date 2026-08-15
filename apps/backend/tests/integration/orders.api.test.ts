import { describe, it } from 'vitest';

/** supertest over the mounted app, against a disposable Neon branch. */
describe('POST /api/v1/orders', () => {
  it('stores a valid signed order as PENDING');
  it('returns 200 with the existing order when the same orderHash is resubmitted');
  it('rejects a signature that does not recover to the order owner');
  it('rejects a non-allowlisted token with TOKEN_NOT_ALLOWED');
  it('rejects amountIn above the on-chain max trade size with TRADE_TOO_LARGE');
  it('rejects amounts sent as JSON numbers instead of decimal strings');
  it('requires authentication');
});

describe('GET /api/v1/orders', () => {
  it('returns only the authenticated caller orders');
  it('does not leak another user orders by id');
});

describe('POST /api/v1/orders/:id/cancel', () => {
  it('cancels from PENDING and from TRIGGERED');
  it('refuses to cancel an order already claimed as EXECUTING');
});
