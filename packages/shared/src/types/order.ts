import type { Address, Hex } from 'viem';

/**
 * Lifecycle of a synthetic order.
 *
 * Legal transitions (enforced centrally in ../domain/orderStateMachine.ts):
 *
 *   PENDING   -> TRIGGERED | CANCELLED
 *   TRIGGERED -> EXECUTING | CANCELLED | FAILED
 *   EXECUTING -> EXECUTED  | FAILED
 *   FAILED    -> TRIGGERED            (retryable classes only)
 *   EXECUTED, CANCELLED               (terminal)
 *
 * EXECUTING is never left on ambiguity. If the transaction outcome is unknown,
 * the order stays EXECUTING and the reconciliation worker resolves it against
 * `consumedOrders[orderHash]` on-chain. Guessing here is how double-execution
 * happens.
 */
export const OrderStatus = {
  /** Stored, signed, waiting for its price condition. */
  PENDING: 'PENDING',
  /** Condition met on a non-suspect price tick. Queued for execution. */
  TRIGGERED: 'TRIGGERED',
  /** Claimed by exactly one worker; a transaction hash exists. */
  EXECUTING: 'EXECUTING',
  /** Receipt succeeded and an OrderExecuted log was observed. Terminal. */
  EXECUTED: 'EXECUTED',
  /** Reverted, dropped, or rejected pre-flight. Semi-terminal; may retry. */
  FAILED: 'FAILED',
  /** Cancelled by the user or expired. Terminal. */
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const OrderSide = {
  SELL: 'SELL',
  BUY: 'BUY',
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const TriggerType = {
  /** Fire when the observed price <= triggerPrice. "Sell ETH when ETH <= $3500". */
  PRICE_BELOW: 'PRICE_BELOW',
  /** Fire when the observed price >= triggerPrice. */
  PRICE_ABOVE: 'PRICE_ABOVE',
} as const;
export type TriggerType = (typeof TriggerType)[keyof typeof TriggerType];

/**
 * The exact tuple the user signs via EIP-712 and the contract verifies.
 *
 * Field-for-field identical to `SyntheticOrderExecutor.Order`. Nothing may be
 * added, removed, or reordered here without changing ORDER_TYPEHASH in the
 * contract — the golden-vector test enforces that.
 *
 * Amounts are bigint in base units (wei / 6-decimal USDC), never numbers.
 */
export interface SignedOrderIntent {
  owner: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** The user's hard floor. The executor may only tighten this, never loosen it. */
  minAmountOut: bigint;
  /** Unix seconds after which the intent is dead. */
  expiry: bigint;
  /** Per-user nonce, cancellable on-chain via `cancelNonce`. */
  nonce: bigint;
}

/**
 * The off-chain trigger condition. This is the part the contract knows nothing
 * about — the backend decides WHEN, the contract enforces HOW.
 */
export interface OrderTrigger {
  /** Oracle pair driving the condition, e.g. "ETH/USD". */
  pair: string;
  type: TriggerType;
  /** Threshold price in USD, as a decimal string to avoid float drift. */
  price: string;
}

/** A full order as the application models it: signed intent + off-chain trigger. */
export interface Order {
  id: string;
  owner: Address;
  side: OrderSide;
  intent: SignedOrderIntent;
  trigger: OrderTrigger;
  /** EIP-712 digest. The global idempotency key, shared with the contract. */
  orderHash: Hex;
  signature: Hex;
  status: OrderStatus;
  /** Optimistic-lock version, bumped on every status transition. */
  version: number;
  triggeredAt?: Date;
  /** Price actually observed when the trigger fired, for post-hoc audit. */
  triggerPriceObserved?: string;
  executedAt?: Date;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}
