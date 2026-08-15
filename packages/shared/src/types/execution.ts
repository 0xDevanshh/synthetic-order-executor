import type { Address, Hex } from 'viem';

/** On-chain fate of a submitted transaction. */
export const TxStatus = {
  SUBMITTED: 'SUBMITTED',
  MINED_SUCCESS: 'MINED_SUCCESS',
  MINED_REVERTED: 'MINED_REVERTED',
  /** No receipt within the monitoring window and the nonce is still unused. */
  DROPPED: 'DROPPED',
  /** Superseded by a same-nonce replacement (fee bump). */
  REPLACED: 'REPLACED',
} as const;
export type TxStatus = (typeof TxStatus)[keyof typeof TxStatus];

/**
 * Why an execution failed, and whether retrying could plausibly help.
 *
 * Classification drives the retry policy: a transient RPC failure is retried, a
 * contract revert like OrderAlreadyConsumed never is.
 */
export const FailureClass = {
  /** RPC timeout, nonce too low, underpriced. Retry. */
  TRANSIENT: 'TRANSIENT',
  /** Market cannot meet the signed floor right now. Retry on a later tick. */
  MARKET_CONDITIONS: 'MARKET_CONDITIONS',
  /** Contract rejected on validation grounds. Do not retry. */
  CONTRACT_REJECTED: 'CONTRACT_REJECTED',
  /** Already executed on-chain. Not a failure — reconcile to EXECUTED. */
  ALREADY_CONSUMED: 'ALREADY_CONSUMED',
  /** Bug or unknown state. Do not retry; surface it. */
  UNKNOWN: 'UNKNOWN',
} as const;
export type FailureClass = (typeof FailureClass)[keyof typeof FailureClass];

/** Everything the executor computed for one attempt, persisted before broadcast. */
export interface ExecutionParams {
  orderId: string;
  attemptNumber: number;
  /** Fresh quote used as the slippage reference. */
  referenceAmountOut: bigint;
  /** max(quote * (1 - slippageBps), signedFloor). Never below the signed floor. */
  runtimeMinAmountOut: bigint;
  poolFee: number;
  /** Unix seconds; bounded by the contract's maxDeadlineWindow. */
  deadline: bigint;
  /** Executor EOA nonce, allocated under the Redis mutex. */
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Outcome of one execution attempt.
 *
 * Note `txHash` is present even on failure: the hash is persisted *before*
 * broadcast, so a transaction can never be sent without a record of it. That
 * single ordering choice is what lets reconciliation converge.
 */
export interface ExecutionResult {
  orderId: string;
  attemptNumber: number;
  success: boolean;
  txHash?: Hex;
  txStatus?: TxStatus;
  blockNumber?: bigint;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  /** Actual output, read from the OrderExecuted event, not from the quote. */
  actualAmountOut?: bigint;
  failure?: {
    class: FailureClass;
    /** Decoded custom error name, e.g. "OrderAlreadyConsumed". */
    reason: string;
    retryable: boolean;
  };
}

/** Decoded `OrderExecuted` log — the reconciler's source of truth. */
export interface OrderExecutedEvent {
  orderHash: Hex;
  owner: Address;
  executor: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  poolFee: number;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
}
