import { OrderStatus } from '@soe/database';

/**
 * The single source of truth for legal order transitions.
 *
 * Pure and dependency-free: no database, no chain, no clock. Every writer in the
 * system validates through this table, and the unit suite walks every from x to
 * pair including the illegal ones.
 *
 *   PENDING   -> TRIGGERED | CANCELLED
 *   TRIGGERED -> EXECUTING | CANCELLED | FAILED
 *   EXECUTING -> EXECUTED  | FAILED
 *   FAILED    -> TRIGGERED            (retry path)
 *   EXECUTED, CANCELLED               (terminal)
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['TRIGGERED', 'CANCELLED'],
  TRIGGERED: ['EXECUTING', 'CANCELLED', 'FAILED'],
  // Note EXECUTING cannot go to CANCELLED. Once a transaction may be in flight,
  // cancelling off-chain would leave the database claiming an order is dead
  // while the chain is about to execute it.
  EXECUTING: ['EXECUTED', 'FAILED'],
  FAILED: ['TRIGGERED'],
  EXECUTED: [],
  CANCELLED: [],
} as const;

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['EXECUTED', 'CANCELLED'];

/**
 * Statuses a user may cancel from.
 *
 * Excludes EXECUTING deliberately: by then a transaction may already be in the
 * mempool, and no off-chain write can recall it. The on-chain escape hatch for
 * that case is the contract's own controls, not this API.
 */
export const USER_CANCELLABLE_STATUSES: readonly OrderStatus[] = ['PENDING', 'TRIGGERED'];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isUserCancellable(status: OrderStatus): boolean {
  return USER_CANCELLABLE_STATUSES.includes(status);
}
