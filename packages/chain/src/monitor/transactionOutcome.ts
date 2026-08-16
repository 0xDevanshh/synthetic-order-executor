import type { Hex } from 'viem';

/**
 * Every state a submitted transaction can be in, from the monitor's view.
 *
 * The distinction that carries all the safety weight is between
 * `DROPPED_NOT_EXECUTED` and `DROPPED_BUT_EXECUTED`. Both look identical from
 * the mempool — there is no receipt either way. Only the contract can tell them
 * apart, via `isExecuted(executionId)`. Collapsing them into one "it failed"
 * case is precisely how a system double-spends: it retries an order that
 * actually settled.
 */
export type TransactionOutcome =
  /** Receipt with status 1, and a SwapExecuted event. Terminal: EXECUTED. */
  | {
      kind: 'SUCCESS';
      txHash: Hex;
      blockNumber: bigint;
      gasUsed: bigint;
      amountOut?: bigint;
    }
  /** Receipt with status 0. Terminal: FAILED. The chain has spoken. */
  | {
      kind: 'REVERTED';
      txHash: Hex;
      blockNumber: bigint;
      gasUsed: bigint;
      reason: string;
    }
  /** No receipt yet, but the transaction is visible. Keep waiting. */
  | { kind: 'PENDING'; txHash: Hex; ageMs: number }
  /**
   * No receipt, transaction not in the mempool, and the executionId is NOT
   * consumed on-chain. Only now is it safe to fail the order and allow a fresh
   * submission.
   */
  | { kind: 'DROPPED_NOT_EXECUTED'; txHash: Hex }
  /**
   * No receipt for THIS hash, but the executionId IS consumed. Some transaction
   * carrying this execution landed — a fee-bump replacement, or a receipt we
   * simply failed to observe. The order EXECUTED. Never retry.
   */
  | { kind: 'DROPPED_BUT_EXECUTED'; txHash: Hex }
  /**
   * The RPC failed. This says nothing about the transaction. Retry the READ;
   * never treat it as a failed execution.
   */
  | { kind: 'RPC_ERROR'; txHash: Hex; error: string };

export function isTerminal(outcome: TransactionOutcome): boolean {
  return (
    outcome.kind === 'SUCCESS' ||
    outcome.kind === 'REVERTED' ||
    outcome.kind === 'DROPPED_NOT_EXECUTED' ||
    outcome.kind === 'DROPPED_BUT_EXECUTED'
  );
}

/** Should the monitor poll again? */
export function shouldKeepPolling(outcome: TransactionOutcome): boolean {
  return outcome.kind === 'PENDING' || outcome.kind === 'RPC_ERROR';
}

/**
 * May a NEW transaction be submitted for this order?
 *
 * True in exactly one case: we have positively established that nothing landed.
 * Anything else — pending, unknown, RPC down — must return false. The default
 * on uncertainty is "do not resubmit", because the cost of being wrong is a
 * duplicate trade with the user's funds, while the cost of waiting is a delay.
 */
export function isSafeToResubmit(outcome: TransactionOutcome): boolean {
  return outcome.kind === 'DROPPED_NOT_EXECUTED';
}
