import type { Order } from '@soe/database';

export interface OrderResponse {
  id: string;
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  side: string;
  amount: string;
  triggerPrice: string;
  status: string;
  executionId: string;
  txHash: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Map a database row to the API shape.
 *
 * Prisma `Decimal` values are serialised with `toString()` rather than left to
 * JSON.stringify, which would render them as objects, and rather than converted
 * to numbers, which would lose precision on exactly the values that matter.
 *
 * `version` is deliberately not exposed: it is an internal concurrency-control
 * detail, and publishing it would invite clients to depend on it.
 */
export function serializeOrder(order: Order): OrderResponse {
  return {
    id: order.id,
    userAddress: order.userAddress,
    tokenIn: order.tokenIn,
    tokenOut: order.tokenOut,
    side: order.side,
    amount: order.amount.toString(),
    triggerPrice: order.triggerPrice.toString(),
    status: order.status,
    executionId: order.executionId,
    txHash: order.txHash,
    errorMessage: order.errorMessage,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
