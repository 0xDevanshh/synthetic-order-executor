import type { OrderStatus } from '@soe/database';

/**
 * Domain errors carry a stable machine-readable `code` and an HTTP status.
 *
 * The error handler maps them straight to the response body, so route handlers
 * never construct HTTP responses for failures and the API's error vocabulary
 * stays defined in one place.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export class OrderNotFoundError extends AppError {
  constructor(id: string) {
    super('ORDER_NOT_FOUND', `Order ${id} not found`, 404);
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(
      'INVALID_TRANSITION',
      `Cannot transition order from ${from} to ${to}`,
      409,
      { from, to },
    );
  }
}

/**
 * Raised when the atomic claim updates zero rows: another worker won the race,
 * or the order left the expected status in between. Not an error condition so
 * much as a "you lost, stand down" signal.
 */
export class ConcurrentModificationError extends AppError {
  constructor(id: string) {
    super(
      'CONCURRENT_MODIFICATION',
      `Order ${id} was modified concurrently; the claim was not acquired`,
      409,
    );
  }
}

export class TokenNotSupportedError extends AppError {
  constructor(symbol: string) {
    super('TOKEN_NOT_SUPPORTED', `Token ${symbol} is not supported`, 400, { symbol });
  }
}

export class TradeTooLargeError extends AppError {
  constructor(amount: string, max: string, symbol: string) {
    super(
      'TRADE_TOO_LARGE',
      `Amount ${amount} ${symbol} exceeds the on-chain maximum of ${max} ${symbol}`,
      400,
      { amount, max, symbol },
    );
  }
}

export class ContractPausedError extends AppError {
  constructor() {
    super('CONTRACT_PAUSED', 'The executor contract is paused; execution is unavailable', 503);
  }
}

export class ExecutionError extends AppError {
  constructor(message: string, details?: unknown) {
    super('EXECUTION_FAILED', message, 502, details);
  }
}
