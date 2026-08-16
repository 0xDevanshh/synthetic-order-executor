import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  decodeEventLog,
  type Hex,
  type PublicClient,
} from 'viem';

import { syntheticOrderExecutorAbi } from '../abi/syntheticOrderExecutor.js';
import type { ExecutorContractClient } from '../contract/executorClient.js';
import type { TransactionOutcome } from './transactionOutcome.js';

export interface MonitorOptions {
  /** How long a transaction may sit without a receipt before it is investigated. */
  pendingGraceMs?: number;
}

/**
 * Resolves what actually happened to a submitted transaction.
 *
 * Read-only. It never signs, never broadcasts and never resubmits — its single
 * responsibility is turning an ambiguous network state into one of the outcomes
 * in transactionOutcome.ts. Deciding what to DO with that outcome belongs to the
 * caller, which keeps the dangerous decision (resubmit or not) separate from the
 * observation.
 */
export class TransactionMonitor {
  private readonly pendingGraceMs: number;

  constructor(
    private readonly client: PublicClient,
    private readonly executor: ExecutorContractClient,
    options: MonitorOptions = {},
  ) {
    this.pendingGraceMs = options.pendingGraceMs ?? 180_000;
  }

  /**
   * Classify a transaction.
   *
   * @param txHash      the hash recorded before broadcast
   * @param executionId the contract-level identity of this execution
   * @param submittedAt when the hash was recorded, for the pending grace period
   *
   * Order of checks matters:
   *   1. Receipt — the strongest evidence; if it exists, nothing else is needed.
   *   2. Still in mempool → PENDING; keep waiting.
   *   3. Gone from the mempool → ask the CONTRACT whether the execution landed.
   *
   * Step 3 is the one that prevents duplicate execution. A missing transaction
   * is not evidence of a missing execution.
   */
  async getOutcome(
    txHash: Hex,
    executionId: Hex,
    submittedAt: Date,
  ): Promise<TransactionOutcome> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: txHash });

      if (receipt.status === 'success') {
        return {
          kind: 'SUCCESS',
          txHash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          amountOut: this.decodeAmountOut(receipt.logs),
        };
      }

      return {
        kind: 'REVERTED',
        txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        reason: await this.decodeRevertReason(txHash, receipt.blockNumber),
      };
    } catch (error) {
      if (!isNotFound(error)) {
        // The RPC failed. This tells us nothing about the transaction, so the
        // outcome must stay unknown rather than be guessed at.
        return {
          kind: 'RPC_ERROR',
          txHash,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return this.investigateMissing(txHash, executionId, submittedAt);
    }
  }

  /**
   * No receipt. Decide whether it is merely slow, or truly gone.
   */
  private async investigateMissing(
    txHash: Hex,
    executionId: Hex,
    submittedAt: Date,
  ): Promise<TransactionOutcome> {
    const ageMs = Date.now() - submittedAt.getTime();

    try {
      // Still visible to the node? Then it is queued, not lost.
      await this.client.getTransaction({ hash: txHash });
      return { kind: 'PENDING', txHash, ageMs };
    } catch (error) {
      if (!isNotFound(error)) {
        return {
          kind: 'RPC_ERROR',
          txHash,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    // Not in the mempool. Before the grace period elapses, treat it as pending
    // anyway: propagation across nodes is not instantaneous, and a transaction
    // can be briefly invisible to the node we happen to be asking.
    if (ageMs < this.pendingGraceMs) {
      return { kind: 'PENDING', txHash, ageMs };
    }

    // THE decisive check. The contract is the only authority on whether this
    // execution happened.
    try {
      const consumed = await this.executor.isExecuted(executionId);
      return consumed
        ? { kind: 'DROPPED_BUT_EXECUTED', txHash }
        : { kind: 'DROPPED_NOT_EXECUTED', txHash };
    } catch (error) {
      // Could not reach the contract. Refuse to conclude anything: without this
      // answer we cannot distinguish "never happened" from "already happened",
      // and guessing wrong means a duplicate trade.
      return {
        kind: 'RPC_ERROR',
        txHash,
        error: `could not verify executionId on-chain: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * Re-run a reverted transaction against its own block to recover the reason.
   *
   * A receipt records that a transaction failed but not why. Replaying the call
   * at the block it failed in surfaces the revert data, which decodes to the
   * contract's custom errors — `SlippageExceeded` is actionable in a way that
   * "reverted" is not.
   */
  private async decodeRevertReason(txHash: Hex, blockNumber: bigint): Promise<string> {
    try {
      const tx = await this.client.getTransaction({ hash: txHash });

      await this.client.call({
        account: tx.from,
        to: tx.to,
        data: tx.input,
        value: tx.value,
        blockNumber,
      });

      // The replay succeeded, so state changed between the failing block and
      // now. Say that plainly rather than inventing a reason.
      return 'reverted (reason not reproducible at block)';
    } catch (error) {
      if (error instanceof BaseError) {
        const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
        if (revert instanceof ContractFunctionRevertedError) {
          const name = revert.data?.errorName;
          if (name) {
            const args = revert.data?.args;
            return args?.length ? `${name}(${args.join(', ')})` : name;
          }
          if (revert.reason) return revert.reason;
        }
        return error.shortMessage || error.message;
      }
      return error instanceof Error ? error.message : 'reverted';
    }
  }

  /** Actual output from the SwapExecuted event. */
  private decodeAmountOut(
    logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[],
  ): bigint | undefined {
    for (const log of logs) {
      if (log.address.toLowerCase() !== this.executor.address.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: syntheticOrderExecutorAbi,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if (decoded.eventName === 'SwapExecuted') {
          return (decoded.args as unknown as { amountOut: bigint }).amountOut;
        }
      } catch {
        // Unrelated event.
      }
    }
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof TransactionReceiptNotFoundError ||
    error instanceof TransactionNotFoundError ||
    (error instanceof Error && /not be found|not found/i.test(error.message))
  );
}
