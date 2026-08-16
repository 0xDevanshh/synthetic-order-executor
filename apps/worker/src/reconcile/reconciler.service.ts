import type { Hex } from 'viem';
import type { OrderRepository, ReconciliationRepository } from '@soe/core';
import type { ExecutorContractClient, SwapExecutedLog } from '@soe/chain';

import type { TxMonitorService } from '../monitor/txMonitor.service.js';
import type { Logger } from '../lib/logger.js';

export interface ReconcilerOptions {
  /** An EXECUTING order older than this is investigated. */
  stuckAfterMs?: number;
  /** Blocks re-scanned below the checkpoint every pass, to absorb reorgs. */
  reorgBufferBlocks?: bigint;
  /** Cap on the block span scanned in a single pass. */
  maxBlockRange?: bigint;
  /** How many orders each audit pass inspects. */
  auditLimit?: number;
}

export interface ReconcileReport {
  stuckChecked: number;
  stuckResolved: number;
  logsScanned: number;
  backfilled: number;
  failedButExecuted: number;
  executedWithoutEvidence: number;
  fromBlock?: string;
  toBlock?: string;
  errors: string[];
}

/**
 * Periodic reconciliation.
 *
 * PRINCIPLE: the blockchain is the source of truth. The database is a cache of
 * it, and caches go stale — a worker dies mid-flight, an RPC times out between
 * the receipt and the write, a deploy lands between submit and confirm. This
 * worker re-derives order state from chain evidence and corrects the database.
 *
 * IDEMPOTENCE is structural, not incidental. Every pass:
 *   - reads current chain state rather than acting on a stored delta,
 *   - guards each write on the status it expects to find,
 *   - treats "already correct" as a no-op rather than an error.
 * Running it twice, or ten times, converges to the same state. Running it
 * against a fully consistent database performs zero writes.
 *
 * Each pass is independently try/caught: a failure in one must not prevent the
 * others from running, because they cover different failure modes.
 */
export class ReconcilerService {
  private readonly stuckAfterMs: number;
  private readonly reorgBufferBlocks: bigint;
  private readonly maxBlockRange: bigint;
  private readonly auditLimit: number;

  constructor(
    private readonly orders: OrderRepository,
    private readonly recon: ReconciliationRepository,
    private readonly executor: ExecutorContractClient,
    private readonly monitor: TxMonitorService,
    private readonly logger: Logger,
    options: ReconcilerOptions = {},
  ) {
    this.stuckAfterMs = options.stuckAfterMs ?? 300_000;
    this.reorgBufferBlocks = options.reorgBufferBlocks ?? 12n;
    this.maxBlockRange = options.maxBlockRange ?? 5_000n;
    this.auditLimit = options.auditLimit ?? 100;
  }

  async run(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      stuckChecked: 0,
      stuckResolved: 0,
      logsScanned: 0,
      backfilled: 0,
      failedButExecuted: 0,
      executedWithoutEvidence: 0,
      errors: [],
    };

    await this.safely('sweepStuckExecuting', report, () => this.sweepStuckExecuting(report));
    await this.safely('backfillFromLogs', report, () => this.backfillFromLogs(report));
    await this.safely('auditFailed', report, () => this.auditFailed(report));
    await this.safely('auditExecuted', report, () => this.auditExecuted(report));

    this.logger.info({ ...report }, 'reconciliation pass complete');
    return report;
  }

  /** One pass failing must not stop the others; they cover different faults. */
  private async safely(
    name: string,
    report: ReconcileReport,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${name}: ${message}`);
      this.logger.error({ pass: name, error: message }, 'reconciliation pass failed');
    }
  }

  // -------------------------------------------------------------------------
  // PASS 1 — orders stuck in EXECUTING
  //
  // Covers: worker crashed after submission; a monitor job that was lost; a
  // transaction that succeeded, reverted, or is still pending while the database
  // never learned which.
  //
  // Delegates to TxMonitorService, which already encodes the safe classification
  // (and never concludes anything from an RPC failure). Reusing it means there
  // is ONE implementation of "decide what happened to this transaction" rather
  // than a second, subtly different copy here.
  // -------------------------------------------------------------------------
  private async sweepStuckExecuting(report: ReconcileReport): Promise<void> {
    const stuck = await this.orders.findStuckExecuting(this.stuckAfterMs, this.auditLimit);
    report.stuckChecked = stuck.length;
    if (stuck.length === 0) return;

    for (const order of stuck) {
      const result = await this.monitor.check(order.id);

      // PENDING and UNKNOWN are not resolutions. The order stays EXECUTING and
      // the next pass looks again — which is correct: a slow transaction is not
      // a broken one, and an unreachable RPC is not evidence of anything.
      if (result.status === 'EXECUTED' || result.status === 'FAILED') {
        report.stuckResolved += 1;

        await this.recon.log({
          orderId: order.id,
          kind: 'STUCK_EXECUTING',
          discrepancy: `order stuck in EXECUTING since ${order.submittedAt?.toISOString() ?? 'unknown'}`,
          resolution: `resolved to ${result.status} from chain state`,
          txHash: result.txHash ?? undefined,
        });

        this.logger.warn(
          {
            orderId: order.id,
            executionId: order.executionId,
            txHash: result.txHash,
            status: result.status,
            error: result.error ?? null,
          },
          'reconciler resolved a stuck EXECUTING order',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // PASS 2 — backfill from SwapExecuted logs
  //
  // Covers: the blockchain succeeded but the database update failed. The event
  // is on-chain regardless of whether any worker survived long enough to write
  // the row, so the log is the evidence of record.
  //
  // Idempotent by construction: an execution already recorded as EXECUTED
  // produces no write.
  // -------------------------------------------------------------------------
  private async backfillFromLogs(report: ReconcileReport): Promise<void> {
    const head = await this.executor.getBlockNumber();
    const checkpoint = await this.recon.getCheckpoint();

    // Re-scan the reorg buffer every pass: a block that was canonical last time
    // may not be now, and re-applying a confirmed execution is a no-op anyway.
    const from = checkpoint
      ? maxBigInt(0n, checkpoint.lastProcessedBlock - this.reorgBufferBlocks)
      : maxBigInt(0n, head - this.maxBlockRange);

    const to = minBigInt(head, from + this.maxBlockRange);
    if (to < from) return;

    const logs = await this.executor.getSwapExecutedLogs(from, to);
    report.logsScanned = logs.length;
    report.fromBlock = from.toString();
    report.toBlock = to.toString();

    for (const log of logs) {
      if (await this.applyLog(log)) report.backfilled += 1;
    }

    // Advanced only after every log in the range is applied. Advancing first
    // would silently skip executions if this pass died midway.
    await this.recon.setCheckpoint(to);
  }

  /** Apply one on-chain execution to the database. Returns true if it corrected something. */
  private async applyLog(log: SwapExecutedLog): Promise<boolean> {
    const order = await this.orders.findByExecutionId(log.executionId);

    if (!order) {
      // An execution with no matching order. Either another deployment shares
      // this contract, or the order row was lost. Never fabricate an order from
      // a log — just record it loudly.
      await this.recon.log({
        kind: 'LOG_BACKFILL',
        discrepancy: `SwapExecuted for unknown executionId ${log.executionId}`,
        resolution: 'logged only; no order row exists to update',
        txHash: log.txHash,
        blockNumber: log.blockNumber,
      });
      return false;
    }

    // Already correct. The overwhelmingly common case, and the reason repeated
    // runs are cheap.
    if (order.status === 'EXECUTED') return false;

    const corrected = await this.orders.forceExecutedFromReconciliation({
      id: order.id,
      expectedStatus: order.status,
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      amountOut: log.amountOut,
      note: `reconciled from SwapExecuted log at block ${log.blockNumber}`,
    });

    if (!corrected) return false;

    await this.recon.log({
      orderId: order.id,
      kind: 'LOG_BACKFILL',
      discrepancy: `database said ${order.status}, chain emitted SwapExecuted`,
      resolution: 'corrected to EXECUTED from log evidence',
      txHash: log.txHash,
      blockNumber: log.blockNumber,
    });

    this.logger.warn(
      {
        orderId: order.id,
        executionId: order.executionId,
        txHash: log.txHash,
        status: 'EXECUTED',
        error: null,
        previousStatus: order.status,
      },
      'reconciler corrected an order from SwapExecuted log',
    );

    return true;
  }

  // -------------------------------------------------------------------------
  // PASS 3 — FAILED orders that actually executed
  //
  // The most consequential correction in the system. A FAILED order whose
  // executionId is consumed on-chain means the user's funds moved while the
  // database shows a failure. Left uncorrected the user sees a lie, and any
  // retry logic would treat the order as eligible again.
  //
  // Catches executions older than the log scan window, which pass 2 cannot see.
  // -------------------------------------------------------------------------
  private async auditFailed(report: ReconcileReport): Promise<void> {
    const failed = await this.orders.findManyByStatus('FAILED', this.auditLimit);

    for (const order of failed) {
      // Only orders that got as far as signing can possibly have executed.
      if (!order.txHash && !order.submittedAt) continue;

      const consumed = await this.executor.isExecuted(order.executionId as Hex);
      if (!consumed) continue;

      const corrected = await this.orders.forceExecutedFromReconciliation({
        id: order.id,
        expectedStatus: 'FAILED',
        note: 'reconciled: executionId consumed on-chain despite FAILED status',
      });

      if (!corrected) continue;
      report.failedButExecuted += 1;

      await this.recon.log({
        orderId: order.id,
        kind: 'FAILED_BUT_EXECUTED',
        discrepancy: `database said FAILED (${order.errorMessage ?? 'no reason'}), but executionId is consumed on-chain`,
        resolution: 'corrected to EXECUTED; chain is authoritative',
        txHash: order.txHash ?? undefined,
      });

      this.logger.error(
        {
          orderId: order.id,
          executionId: order.executionId,
          txHash: order.txHash,
          status: 'EXECUTED',
          error: 'was incorrectly marked FAILED',
        },
        'reconciler corrected a FAILED order that had actually executed',
      );
    }
  }

  // -------------------------------------------------------------------------
  // PASS 4 — EXECUTED orders with no on-chain evidence
  //
  // The inverse, and rarer: the database claims success the chain cannot
  // confirm. This is NOT auto-corrected, deliberately — see below.
  // -------------------------------------------------------------------------
  private async auditExecuted(report: ReconcileReport): Promise<void> {
    const executed = await this.orders.findManyByStatus('EXECUTED', this.auditLimit);

    for (const order of executed) {
      const consumed = await this.executor.isExecuted(order.executionId as Hex);
      if (consumed) continue;

      report.executedWithoutEvidence += 1;

      // Deliberately NOT corrected automatically. Flipping EXECUTED back to
      // EXECUTING would make the order eligible for submission again, and if
      // this reading is wrong — a lagging RPC, an archive node serving stale
      // state — that is a duplicate trade. The asymmetry is intentional: a
      // false "executed" is a reporting bug, while a false re-execution spends
      // the user's funds twice. Surface it, do not act on it.
      await this.recon.log({
        orderId: order.id,
        kind: 'EXECUTED_NO_EVIDENCE',
        discrepancy: 'database says EXECUTED but executionId is NOT consumed on-chain',
        resolution: 'logged for investigation; NOT auto-corrected (re-execution risk)',
        txHash: order.txHash ?? undefined,
      });

      this.logger.error(
        {
          orderId: order.id,
          executionId: order.executionId,
          txHash: order.txHash,
          status: 'EXECUTED',
          error: 'no on-chain evidence for this execution',
        },
        'INVESTIGATE: order marked EXECUTED without on-chain evidence',
      );
    }
  }
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
