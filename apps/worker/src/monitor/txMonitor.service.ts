import { formatUnits, type Hex } from 'viem';
import type { Order } from '@soe/database';
import type { OrderRepository } from '@soe/core';
import type { TransactionMonitor, TransactionOutcome } from '@soe/chain';

import type { Logger } from '../lib/logger.js';

export interface MonitorResult {
  orderId: string;
  executionId: string;
  txHash: string | null;
  status: 'EXECUTED' | 'FAILED' | 'PENDING' | 'UNKNOWN' | 'SKIPPED';
  error?: string;
  /** True when the monitor wants to be called again. */
  requeue: boolean;
}

/**
 * Turns a transaction outcome into an order state change.
 *
 * The monitor CLASSIFIES (in @soe/chain); this service DECIDES. Keeping the two
 * apart means the dangerous decision — is it safe to give up on this order —
 * lives in one small, heavily tested place.
 *
 * Every log line carries orderId, executionId, txHash, status and error, so a
 * single grep on an order id reconstructs its whole lifecycle.
 */
export class TxMonitorService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly monitor: TransactionMonitor,
    private readonly logger: Logger,
  ) {}

  async check(orderId: string): Promise<MonitorResult> {
    const order = await this.orders.findById(orderId);

    if (!order) {
      return {
        orderId,
        executionId: '',
        txHash: null,
        status: 'SKIPPED',
        error: 'order not found',
        requeue: false,
      };
    }

    const base = { orderId: order.id, executionId: order.executionId };

    // Already terminal. Another path resolved it; nothing to do.
    if (order.status !== 'EXECUTING') {
      this.logger.info(
        { ...base, txHash: order.txHash, status: order.status },
        'order is no longer EXECUTING; monitoring complete',
      );
      return { ...base, txHash: order.txHash, status: 'SKIPPED', requeue: false };
    }

    // EXECUTING with no hash means the process died between the claim and
    // signing. Nothing was ever broadcast, so failing it is safe — and it is the
    // only branch where that conclusion needs no on-chain evidence.
    if (!order.txHash || !order.submittedAt) {
      return this.resolveNeverSubmitted(order);
    }

    await this.orders.incrementMonitorAttempts(order.id);

    const outcome = await this.monitor.getOutcome(
      order.txHash as Hex,
      order.executionId as Hex,
      order.submittedAt,
    );

    return this.apply(order, outcome);
  }

  private async resolveNeverSubmitted(order: Order): Promise<MonitorResult> {
    const base = { orderId: order.id, executionId: order.executionId };

    this.logger.warn(
      { ...base, txHash: null, status: 'FAILED', error: 'no transaction was ever signed' },
      'order was EXECUTING without a tx hash; failing it as never-submitted',
    );

    await this.orders.markFailed({
      id: order.id,
      errorMessage: 'no transaction recorded: process died before signing',
    });

    return { ...base, txHash: null, status: 'FAILED', requeue: false };
  }

  private async apply(order: Order, outcome: TransactionOutcome): Promise<MonitorResult> {
    const base = { orderId: order.id, executionId: order.executionId };

    switch (outcome.kind) {
      case 'SUCCESS': {
        await this.orders.markConfirmed({
          id: order.id,
          txHash: outcome.txHash,
          blockNumber: outcome.blockNumber,
          gasUsed: outcome.gasUsed,
          amountOut: outcome.amountOut,
        });

        this.logger.info(
          {
            ...base,
            txHash: outcome.txHash,
            status: 'EXECUTED',
            error: null,
            blockNumber: outcome.blockNumber.toString(),
            gasUsed: outcome.gasUsed.toString(),
            amountOut: outcome.amountOut ? formatUnits(outcome.amountOut, 6) : undefined,
          },
          'transaction confirmed: order EXECUTED',
        );

        return { ...base, txHash: outcome.txHash, status: 'EXECUTED', requeue: false };
      }

      case 'REVERTED': {
        await this.orders.markFailed({
          id: order.id,
          errorMessage: outcome.reason,
          txHash: outcome.txHash,
          blockNumber: outcome.blockNumber,
          gasUsed: outcome.gasUsed,
        });

        this.logger.error(
          {
            ...base,
            txHash: outcome.txHash,
            status: 'FAILED',
            error: outcome.reason,
            blockNumber: outcome.blockNumber.toString(),
          },
          'transaction reverted on-chain: order FAILED',
        );

        return {
          ...base,
          txHash: outcome.txHash,
          status: 'FAILED',
          error: outcome.reason,
          requeue: false,
        };
      }

      case 'PENDING': {
        this.logger.info(
          { ...base, txHash: outcome.txHash, status: 'PENDING', ageMs: outcome.ageMs },
          'transaction still pending; will re-check',
        );

        return { ...base, txHash: outcome.txHash, status: 'PENDING', requeue: true };
      }

      case 'DROPPED_BUT_EXECUTED': {
        // The hash we tracked never landed, but the contract says this execution
        // is spent. Something carrying it did land. Marking this FAILED would be
        // wrong AND dangerous: it would invite a retry that duplicates a trade
        // the user has already paid for.
        await this.orders.markConfirmed({
          id: order.id,
          txHash: outcome.txHash,
          blockNumber: 0n,
          gasUsed: 0n,
        });

        this.logger.warn(
          { ...base, txHash: outcome.txHash, status: 'EXECUTED', error: 'receipt not observed' },
          'no receipt for tracked hash but executionId is consumed on-chain: order EXECUTED',
        );

        return { ...base, txHash: outcome.txHash, status: 'EXECUTED', requeue: false };
      }

      case 'DROPPED_NOT_EXECUTED': {
        // Positively established that nothing landed. THE ONLY state from which
        // a fresh submission would be safe.
        await this.orders.markFailed({
          id: order.id,
          errorMessage: 'transaction dropped from mempool; execution did not occur',
          txHash: outcome.txHash,
        });

        this.logger.warn(
          {
            ...base,
            txHash: outcome.txHash,
            status: 'FAILED',
            error: 'dropped, executionId unconsumed',
          },
          'transaction dropped and execution confirmed absent: order FAILED (safe to re-trigger)',
        );

        return { ...base, txHash: outcome.txHash, status: 'FAILED', requeue: false };
      }

      case 'RPC_ERROR': {
        // We learned nothing. The order stays EXECUTING — deliberately. Leaving
        // it in an unresolved state is correct: any other choice asserts
        // something about the chain that we cannot currently observe.
        this.logger.warn(
          { ...base, txHash: outcome.txHash, status: 'UNKNOWN', error: outcome.error },
          'could not determine transaction outcome; leaving order EXECUTING and re-checking',
        );

        return {
          ...base,
          txHash: outcome.txHash,
          status: 'UNKNOWN',
          error: outcome.error,
          requeue: true,
        };
      }
    }
  }

  /**
   * Sweep orders stuck in EXECUTING.
   *
   * The safety net for a lost monitor job — a worker crash, a Redis flush, a
   * deploy mid-flight. Without it an order could sit in EXECUTING forever with a
   * settled transaction nobody ever looked at.
   */
  async sweepStuck(olderThanMs: number, limit = 50): Promise<MonitorResult[]> {
    const stuck = await this.orders.findStuckExecuting(olderThanMs, limit);
    if (stuck.length === 0) return [];

    this.logger.info({ count: stuck.length }, 'sweeping orders stuck in EXECUTING');

    const results: MonitorResult[] = [];
    for (const order of stuck) {
      results.push(await this.check(order.id));
    }
    return results;
  }
}
