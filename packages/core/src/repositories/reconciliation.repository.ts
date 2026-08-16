import { prisma, type IndexerCheckpoint, type ReconciliationLog } from '@soe/database';

export interface ReconciliationLogEntry {
  orderId?: string;
  kind: 'STUCK_EXECUTING' | 'LOG_BACKFILL' | 'FAILED_BUT_EXECUTED' | 'EXECUTED_NO_EVIDENCE';
  discrepancy: string;
  resolution: string;
  txHash?: string;
  blockNumber?: bigint;
}

const CHECKPOINT_ID = 'default';

/**
 * Checkpoint and audit-trail persistence for the reconciler.
 */
export class ReconciliationRepository {
  constructor(private readonly db = prisma) {}

  async getCheckpoint(): Promise<IndexerCheckpoint | null> {
    return this.db.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
  }

  /**
   * Advance the checkpoint.
   *
   * Never moves backwards: a slow or lagging RPC could otherwise rewind it and
   * cause the scan window to grow without bound on every pass.
   */
  async setCheckpoint(blockNumber: bigint): Promise<void> {
    const existing = await this.getCheckpoint();
    if (existing && existing.lastProcessedBlock >= blockNumber) return;

    await this.db.indexerCheckpoint.upsert({
      where: { id: CHECKPOINT_ID },
      create: { id: CHECKPOINT_ID, lastProcessedBlock: blockNumber },
      update: { lastProcessedBlock: blockNumber },
    });
  }

  async log(entry: ReconciliationLogEntry): Promise<ReconciliationLog> {
    return this.db.reconciliationLog.create({
      data: {
        orderId: entry.orderId ?? null,
        kind: entry.kind,
        discrepancy: entry.discrepancy.slice(0, 1_000),
        resolution: entry.resolution.slice(0, 1_000),
        txHash: entry.txHash ?? null,
        blockNumber: entry.blockNumber ?? null,
      },
    });
  }

  async recentLogs(limit = 50): Promise<ReconciliationLog[]> {
    return this.db.reconciliationLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

export const reconciliationRepository = new ReconciliationRepository();
