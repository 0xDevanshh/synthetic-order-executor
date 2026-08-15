import { z } from 'zod';

/**
 * Amounts and prices cross the wire as decimal STRINGS.
 *
 * A JSON number cannot represent 1e18 (or even 0.1) exactly, and these values
 * are what the user commits funds against. Accepting a number here would
 * silently corrupt the amount before it ever reached the chain, so the schema
 * refuses one outright rather than coercing.
 */
const decimalString = (label: string) =>
  z
    .string({ invalid_type_error: `${label} must be a decimal string, not a number` })
    .trim()
    .regex(/^\d+(\.\d+)?$/, `${label} must be a positive decimal string`)
    .refine((v) => Number(v) > 0, `${label} must be greater than zero`)
    .refine((v) => (v.split('.')[1]?.length ?? 0) <= 18, `${label} exceeds 18 decimal places`);

export const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a valid 20-byte EVM address');

export const orderStatusSchema = z.enum([
  'PENDING',
  'TRIGGERED',
  'EXECUTING',
  'EXECUTED',
  'FAILED',
  'CANCELLED',
]);

export const createOrderSchema = z
  .object({
    userAddress: addressSchema,
    tokenIn: z.string().trim().min(1).max(16),
    tokenOut: z.string().trim().min(1).max(16),
    side: z.enum(['BUY', 'SELL']),
    amount: decimalString('amount'),
    triggerPrice: decimalString('triggerPrice'),
  })
  .strict();

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const listOrdersQuerySchema = z
  .object({
    userAddress: addressSchema.optional(),
    status: orderStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const orderIdParamSchema = z.object({
  id: z.string().uuid('order id must be a UUID'),
});
