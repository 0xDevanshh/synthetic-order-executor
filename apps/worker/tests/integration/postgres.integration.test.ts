import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@soe/database';
import { OrderRepository, ReconciliationRepository, deriveExecutionId } from '@soe/core';

/**
 * Integration tests against REAL PostgreSQL.
 *
 * These exist because the unit suite uses an in-memory repository, and a
 * single-threaded JavaScript fake cannot exhibit a genuine race. The atomic
 * claim is the database-level defence against duplicate execution, and until it
 * has faced concurrent transactions on a real engine, it is unproven.
 *
 * Requires a running Postgres (infra/docker/docker-compose.yml --profile local-db)
 * and TEST_DATABASE_URL. Skipped otherwise, so the default suite needs no
 * infrastructure.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('PostgreSQL integration', () => {
  let prisma: PrismaClient;
  let repo: OrderRepository;
  let recon: ReconciliationRepository;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    repo = new OrderRepository(prisma);
    recon = new ReconciliationRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.reconciliationLog.deleteMany();
    await prisma.order.deleteMany();
    await prisma.indexerCheckpoint.deleteMany();
  });

  async function seed(overrides: Partial<Prisma.OrderCreateInput> = {}) {
    const id = randomUUID();
    return prisma.order.create({
      data: {
        id,
        userAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        tokenIn: 'ETH',
        tokenOut: 'USDC',
        side: 'SELL',
        amount: new Prisma.Decimal('0.01'),
        triggerPrice: new Prisma.Decimal('3500'),
        executionId: deriveExecutionId(id),
        ...overrides,
      },
    });
  }

  // -------------------------------------------------------------------------
  // The claim, under genuine concurrency
  // -------------------------------------------------------------------------
  describe('atomic claim', () => {
    it('lets exactly ONE of 20 concurrent claims succeed', async () => {
      // The test the fake could never run. Twenty real connections, twenty real
      // transactions, one row. Postgres serialises the UPDATEs; the losers
      // re-evaluate their WHERE clause after the winner commits, see the bumped
      // version, and match zero rows.
      const order = await seed({ status: 'TRIGGERED' });

      const clients = Array.from(
        { length: 20 },
        () => new PrismaClient({ datasources: { db: { url: DATABASE_URL } } }),
      );

      try {
        const results = await Promise.all(
          clients.map((client) =>
            new OrderRepository(client).transitionStatus({
              id: order.id,
              expectedStatus: 'TRIGGERED',
              expectedVersion: order.version,
              nextStatus: 'EXECUTING',
            }),
          ),
        );

        const winners = results.filter((r) => r !== null);
        expect(winners).toHaveLength(1);
        expect(winners[0]?.status).toBe('EXECUTING');

        const final = await repo.findById(order.id);
        expect(final?.status).toBe('EXECUTING');
        // One increment, not twenty.
        expect(final?.version).toBe(order.version + 1);
      } finally {
        await Promise.all(clients.map((c) => c.$disconnect()));
      }
    });

    it('rejects a claim whose expected version is stale', async () => {
      const order = await seed({ status: 'TRIGGERED' });

      await repo.transitionStatus({
        id: order.id,
        expectedStatus: 'TRIGGERED',
        expectedVersion: order.version,
        nextStatus: 'EXECUTING',
      });

      const stale = await repo.transitionStatus({
        id: order.id,
        expectedStatus: 'TRIGGERED',
        expectedVersion: order.version,
        nextStatus: 'EXECUTING',
      });

      expect(stale).toBeNull();
    });

    it('enforces the unique executionId constraint', async () => {
      // The database-level backstop against two orders sharing a replay key.
      const first = await seed();
      await expect(seed({ executionId: first.executionId })).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // The real trigger query — mirrored by the fake, never verified until now
  // -------------------------------------------------------------------------
  describe('findTriggerable (real SQL)', () => {
    it('returns a SELL order when the price is at or below its trigger', async () => {
      const order = await seed({ side: 'SELL', triggerPrice: new Prisma.Decimal('3500') });

      expect((await repo.findTriggerable('3490')).map((o) => o.id)).toContain(order.id);
      expect((await repo.findTriggerable('3500')).map((o) => o.id)).toContain(order.id);
      expect((await repo.findTriggerable('3600')).map((o) => o.id)).not.toContain(order.id);
    });

    it('returns a BUY order when the price is at or above its trigger', async () => {
      const order = await seed({ side: 'BUY', triggerPrice: new Prisma.Decimal('3500') });

      expect((await repo.findTriggerable('3600')).map((o) => o.id)).toContain(order.id);
      expect((await repo.findTriggerable('3500')).map((o) => o.id)).toContain(order.id);
      expect((await repo.findTriggerable('3400')).map((o) => o.id)).not.toContain(order.id);
    });

    it('compares Decimal(38,18) exactly, with no float rounding', async () => {
      // The boundary the whole system turns on. A float comparison in Postgres
      // would collapse these two into equality.
      const order = await seed({ triggerPrice: new Prisma.Decimal('3500.000000000000000001') });

      expect((await repo.findTriggerable('3500.000000000000000000')).map((o) => o.id)).toContain(
        order.id,
      );
      expect(
        (await repo.findTriggerable('3500.000000000000000002')).map((o) => o.id),
      ).not.toContain(order.id);
    });

    it('excludes every non-PENDING status', async () => {
      for (const status of ['TRIGGERED', 'EXECUTING', 'EXECUTED', 'FAILED', 'CANCELLED'] as const) {
        await seed({ status });
      }

      expect(await repo.findTriggerable('1')).toHaveLength(0);
    });

    it('honours the batch limit', async () => {
      for (let i = 0; i < 5; i += 1) await seed();
      expect(await repo.findTriggerable('1', 3)).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle writes
  // -------------------------------------------------------------------------
  describe('execution lifecycle writes', () => {
    it('records the tx hash and stamps submittedAt', async () => {
      const order = await seed({ status: 'EXECUTING' });
      const hash = `0x${'ab'.repeat(32)}`;

      const updated = await repo.recordTxHash(order.id, hash);

      expect(updated?.txHash).toBe(hash);
      expect(updated?.submittedAt).toBeInstanceOf(Date);
    });

    it('refuses to record a hash against a non-EXECUTING order', async () => {
      const order = await seed({ status: 'PENDING' });
      expect(await repo.recordTxHash(order.id, `0x${'cd'.repeat(32)}`)).toBeNull();
    });

    it('persists amountOut as an exact Decimal, not a float', async () => {
      const order = await seed({ status: 'EXECUTING' });

      const updated = await repo.markConfirmed({
        id: order.id,
        txHash: `0x${'ef'.repeat(32)}`,
        blockNumber: 11_500_000n,
        gasUsed: 210_451n,
        amountOut: 254_812_345n,
      });

      expect(updated?.status).toBe('EXECUTED');
      expect(updated?.amountOut?.toString()).toBe('254812345');
      expect(updated?.blockNumber).toBe(11_500_000n);
      expect(updated?.confirmedAt).toBeInstanceOf(Date);
    });

    it('finds orders stuck in EXECUTING past a cutoff', async () => {
      const old = await seed({
        status: 'EXECUTING',
        submittedAt: new Date(Date.now() - 600_000),
      });
      await seed({ status: 'EXECUTING', submittedAt: new Date() });

      const stuck = await repo.findStuckExecuting(300_000);

      expect(stuck.map((o) => o.id)).toEqual([old.id]);
    });
  });

  // -------------------------------------------------------------------------
  // Reconciliation persistence
  // -------------------------------------------------------------------------
  describe('reconciliation persistence', () => {
    it('never moves the checkpoint backwards', async () => {
      // A lagging RPC could otherwise rewind it and make the scan window grow
      // without bound on every pass.
      await recon.setCheckpoint(11_500_000n);
      await recon.setCheckpoint(11_499_000n);

      expect((await recon.getCheckpoint())?.lastProcessedBlock).toBe(11_500_000n);
    });

    it('advances the checkpoint forwards', async () => {
      await recon.setCheckpoint(11_500_000n);
      await recon.setCheckpoint(11_500_100n);

      expect((await recon.getCheckpoint())?.lastProcessedBlock).toBe(11_500_100n);
    });

    it('writes an audit entry for every correction', async () => {
      const order = await seed({ status: 'FAILED' });

      await recon.log({
        orderId: order.id,
        kind: 'FAILED_BUT_EXECUTED',
        discrepancy: 'db said FAILED, chain says consumed',
        resolution: 'corrected to EXECUTED',
      });

      const logs = await recon.recentLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.kind).toBe('FAILED_BUT_EXECUTED');
    });

    it('forces EXECUTED from FAILED only when the expected status matches', async () => {
      const order = await seed({ status: 'FAILED' });

      const corrected = await repo.forceExecutedFromReconciliation({
        id: order.id,
        expectedStatus: 'FAILED',
        note: 'reconciled from chain',
      });
      expect(corrected?.status).toBe('EXECUTED');

      // Re-running is a no-op: the guard no longer matches. This is what makes
      // reconciliation safe to run repeatedly.
      const again = await repo.forceExecutedFromReconciliation({
        id: order.id,
        expectedStatus: 'FAILED',
        note: 'reconciled from chain',
      });
      expect(again).toBeNull();
    });
  });
});
