import { OrderStatus } from '../types/order.js';

/**
 * The single source of truth for legal order transitions.
 *
 * Deliberately pure and dependency-free: no database, no chain, no clock. Every
 * writer in the system (API, trigger evaluator, executor, tx monitor,
 * reconciler) validates through this table, and the unit suite walks every
 * from x to pair including the illegal ones.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.TRIGGERED, OrderStatus.CANCELLED],
  [OrderStatus.TRIGGERED]: [OrderStatus.EXECUTING, OrderStatus.CANCELLED, OrderStatus.FAILED],
  [OrderStatus.EXECUTING]: [OrderStatus.EXECUTED, OrderStatus.FAILED],
  // Retry path: only for failures classified retryable, and only below
  // MAX_EXECUTION_ATTEMPTS. Safe because on-chain replay protection makes a
  // duplicate submission impossible to double-execute.
  [OrderStatus.FAILED]: [OrderStatus.TRIGGERED],
  [OrderStatus.EXECUTED]: [],
  [OrderStatus.CANCELLED]: [],
} as const;

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  OrderStatus.EXECUTED,
  OrderStatus.CANCELLED,
];

/** Statuses a user is allowed to cancel from. Once claimed, cancellation is off-chain-only too late. */
export const USER_CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.TRIGGERED,
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// TODO(impl): assertTransition(from, to) throwing a typed InvalidTransitionError.
