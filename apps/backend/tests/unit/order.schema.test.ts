import { describe, expect, it } from 'vitest';

import {
  createOrderSchema,
  listOrdersQuerySchema,
} from '../../src/api/schemas/order.schema.js';
import { validOrderInput } from '../helpers/fakes.js';

describe('createOrderSchema', () => {
  it('accepts the documented payload', () => {
    const result = createOrderSchema.safeParse(validOrderInput());
    expect(result.success).toBe(true);
  });

  it('rejects amounts sent as JSON numbers', () => {
    // The important one. A JSON number cannot hold 0.1 or 1e18 exactly, and this
    // value is what the user commits funds against — so it is refused outright
    // rather than coerced.
    const result = createOrderSchema.safeParse({ ...validOrderInput(), amount: 0.01 });
    expect(result.success).toBe(false);
  });

  it('rejects a triggerPrice sent as a JSON number', () => {
    const result = createOrderSchema.safeParse({ ...validOrderInput(), triggerPrice: 3500 });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed address', () => {
    expect(createOrderSchema.safeParse(validOrderInput({ userAddress: '0xdead' })).success).toBe(
      false,
    );
    expect(
      createOrderSchema.safeParse(validOrderInput({ userAddress: 'not-an-address' })).success,
    ).toBe(false);
  });

  it('rejects zero and negative amounts', () => {
    expect(createOrderSchema.safeParse(validOrderInput({ amount: '0' })).success).toBe(false);
    expect(createOrderSchema.safeParse(validOrderInput({ amount: '-1' })).success).toBe(false);
  });

  it('rejects more than 18 decimal places', () => {
    expect(
      createOrderSchema.safeParse(validOrderInput({ amount: `0.${'1'.repeat(19)}` })).success,
    ).toBe(false);
  });

  it('rejects an invalid side', () => {
    expect(createOrderSchema.safeParse(validOrderInput({ side: 'HOLD' })).success).toBe(false);
  });

  it('rejects unknown fields rather than silently ignoring them', () => {
    // A typo'd field name should be a loud 400, not a silently dropped value.
    const result = createOrderSchema.safeParse({ ...validOrderInput(), triggerPrize: '3500' });
    expect(result.success).toBe(false);
  });
});

describe('listOrdersQuerySchema', () => {
  it('applies default pagination', () => {
    const result = listOrdersQuerySchema.parse({});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it('coerces numeric query strings', () => {
    const result = listOrdersQuerySchema.parse({ limit: '50', offset: '10' });
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(10);
  });

  it('caps limit at 100', () => {
    expect(listOrdersQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(listOrdersQuerySchema.safeParse({ status: 'NOPE' }).success).toBe(false);
  });
});
