/**
 * Zod schemas for order endpoints.
 *
 * Amounts cross the wire as decimal STRINGS and are parsed to bigint. A JS
 * number cannot represent 1e18 exactly, so accepting one here would silently
 * corrupt the very value the user signed.
 */

// TODO(impl): addressSchema (0x + 40 hex, checksummed), bigintStringSchema,
//             createOrderSchema, prepareOrderSchema, listOrdersQuerySchema.
export {};
