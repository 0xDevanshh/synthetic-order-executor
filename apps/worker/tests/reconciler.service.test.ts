import { beforeEach, describe, expect, it } from 'vitest';
import { parseUnits, type Hex } from 'viem';

import { ReconcilerService } from '../src/reconcile/reconciler.service.js';
import { TxMonitorService } from '../src/monitor/txMonitor.service.js';
import { asRepository, FakeOrderRepository, makeOrder, silentLogger } from './helpers/fakes.js';
import {
  asExecutorClient,
  asMonitor,
  FakeExecutorClient,
  FakeReconciliationRepository,
  FakeTransactionMonitor,
} from './helpers/chainFakes.js';

const TX: Hex = `0x${'ab'.repeat(32)}`;

describe('ReconcilerService', () => {
  let orders: FakeOrderRepository;
  let recon: FakeReconciliationRepository;
  let executor: FakeExecutorClient;
  let monitor: FakeTransactionMonitor;
  let service: ReconcilerService;

  beforeEach(() => {
    orders = new FakeOrderRepository();
    recon = new FakeReconciliationRepository();
    executor = new FakeExecutorClient();
    monitor = new FakeTransactionMonitor();

    service = new ReconcilerService(
      asRepository(orders),
      recon as never,
      asExecutorClient(executor),
      new TxMonitorService(asRepository(orders), asMonitor(monitor), silentLogger),
      silentLogger,
      { stuckAfterMs: 300_000, reorgBufferBlocks: 12n, maxBlockRange: 5_000n },
    );
  });

  const stuckOrder = (overrides = {}) => {
    const order = makeOrder({
      status: 'EXECUTING',
      txHash: TX,
      submittedAt: new Date(Date.now() - 600_000),
      ...overrides,
    });
    orders.add(order);
    return order;
  };

  // -------------------------------------------------------------------------
  // Case 1: DB says EXECUTING, transaction succeeded
  // -------------------------------------------------------------------------
  describe('EXECUTING but the transaction succeeded', () => {
    it('corrects the order to EXECUTED with the on-chain facts', async () => {
      const order = stuckOrder();
      monitor.outcome = {
        kind: 'SUCCESS',
        txHash: TX,
        blockNumber: 11_500_000n,
        gasUsed: 210_000n,
        amountOut: parseUnits('34.9', 6),
      };

      const report = await service.run();

      expect(report.stuckResolved).toBe(1);
      expect(orders.orders.get(order.id)?.status).toBe('EXECUTED');
      expect(orders.orders.get(order.id)?.blockNumber).toBe(11_500_000n);
    });

    it('writes a reconciliation log entry', async () => {
      stuckOrder();
      await service.run();

      const entry = recon.entries.find((e) => e.kind === 'STUCK_EXECUTING');
      expect(entry).toBeDefined();
      expect(entry?.resolution).toContain('EXECUTED');
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: DB says EXECUTING, transaction reverted
  // -------------------------------------------------------------------------
  describe('EXECUTING but the transaction reverted', () => {
    it('corrects the order to FAILED with the decoded reason', async () => {
      const order = stuckOrder();
      monitor.outcome = {
        kind: 'REVERTED',
        txHash: TX,
        blockNumber: 11_500_002n,
        gasUsed: 45_000n,
        reason: 'SlippageExceeded(34000000, 34650000)',
      };

      const report = await service.run();

      expect(report.stuckResolved).toBe(1);
      expect(orders.orders.get(order.id)?.status).toBe('FAILED');
      expect(orders.orders.get(order.id)?.errorMessage).toContain('SlippageExceeded');
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: DB says EXECUTING, transaction still pending
  // -------------------------------------------------------------------------
  describe('EXECUTING and the transaction is still pending', () => {
    it('leaves the order alone — pending is not a failure', async () => {
      const order = stuckOrder();
      monitor.outcome = { kind: 'PENDING', txHash: TX, ageMs: 400_000 };

      const report = await service.run();

      expect(report.stuckResolved).toBe(0);
      expect(orders.orders.get(order.id)?.status).toBe('EXECUTING');
      expect(recon.entries.filter((e) => e.kind === 'STUCK_EXECUTING')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: chain succeeded but the DB update failed
  // -------------------------------------------------------------------------
  describe('chain succeeded but the database update failed', () => {
    it('backfills an EXECUTING order from its SwapExecuted log', async () => {
      const order = makeOrder({ status: 'EXECUTING', txHash: TX, submittedAt: new Date() });
      orders.add(order);

      // No monitor evidence — only the log exists.
      monitor.outcome = { kind: 'RPC_ERROR', txHash: TX, error: 'node down' };
      executor.logs = [
        {
          executionId: order.executionId as Hex,
          owner: order.userAddress as Hex,
          amountIn: parseUnits('0.01', 18),
          amountOut: parseUnits('34.9', 6),
          txHash: TX,
          blockNumber: 11_500_010n,
        },
      ];

      const report = await service.run();

      expect(report.backfilled).toBe(1);
      expect(orders.orders.get(order.id)?.status).toBe('EXECUTED');
      expect(orders.orders.get(order.id)?.amountOut?.toString()).toBe(
        parseUnits('34.9', 6).toString(),
      );
    });

    it('corrects a FAILED order that the chain says executed', async () => {
      // The most consequential correction: the user's funds moved while the
      // database showed a failure.
      const order = makeOrder({
        status: 'FAILED',
        txHash: TX,
        submittedAt: new Date(),
        errorMessage: 'transaction dropped from mempool',
      });
      orders.add(order);
      executor.executed.add(order.executionId.toLowerCase());

      const report = await service.run();

      expect(report.failedButExecuted).toBe(1);
      expect(orders.orders.get(order.id)?.status).toBe('EXECUTED');

      const entry = recon.entries.find((e) => e.kind === 'FAILED_BUT_EXECUTED');
      expect(entry?.discrepancy).toContain('consumed on-chain');
    });

    it('leaves a genuinely FAILED order alone', async () => {
      const order = makeOrder({
        status: 'FAILED',
        txHash: TX,
        submittedAt: new Date(),
        errorMessage: 'SlippageExceeded',
      });
      orders.add(order);
      // executionId NOT consumed.

      const report = await service.run();

      expect(report.failedButExecuted).toBe(0);
      expect(orders.orders.get(order.id)?.status).toBe('FAILED');
    });

    it('ignores FAILED orders that never reached submission', async () => {
      // No hash and no submittedAt means nothing was ever signed, so there is
      // nothing on-chain to check.
      orders.add(
        makeOrder({ status: 'FAILED', txHash: null, submittedAt: null, errorMessage: 'no pool' }),
      );

      await service.run();

      expect(executor.isExecutedCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Case 5: worker crashed after submission
  // -------------------------------------------------------------------------
  describe('worker crashed after submission', () => {
    it('resolves an order whose monitor job was lost', async () => {
      const order = stuckOrder();
      monitor.outcome = {
        kind: 'SUCCESS',
        txHash: TX,
        blockNumber: 11_500_020n,
        gasUsed: 200_000n,
        amountOut: parseUnits('34.9', 6),
      };

      await service.run();

      expect(orders.orders.get(order.id)?.status).toBe('EXECUTED');
    });

    it('fails an order that crashed before anything was signed', async () => {
      const order = makeOrder({
        status: 'EXECUTING',
        txHash: null,
        submittedAt: new Date(Date.now() - 600_000),
      });
      orders.add(order);

      await service.run();

      expect(orders.orders.get(order.id)?.status).toBe('FAILED');
      expect(orders.orders.get(order.id)?.errorMessage).toContain('before signing');
    });
  });

  // -------------------------------------------------------------------------
  // Idempotence
  // -------------------------------------------------------------------------
  describe('idempotence', () => {
    it('performs no writes against an already-consistent database', async () => {
      const order = makeOrder({ status: 'EXECUTED', txHash: TX, blockNumber: 11_500_000n });
      orders.add(order);
      executor.executed.add(order.executionId.toLowerCase());
      executor.logs = [
        {
          executionId: order.executionId as Hex,
          owner: order.userAddress as Hex,
          amountIn: parseUnits('0.01', 18),
          amountOut: parseUnits('34.9', 6),
          txHash: TX,
          blockNumber: 11_500_000n,
        },
      ];

      const report = await service.run();

      expect(report.backfilled).toBe(0);
      expect(report.failedButExecuted).toBe(0);
      expect(report.executedWithoutEvidence).toBe(0);
      expect(recon.entries).toHaveLength(0);
    });

    it('converges to the same state over repeated runs', async () => {
      const order = makeOrder({ status: 'EXECUTING', txHash: TX, submittedAt: new Date() });
      orders.add(order);
      monitor.outcome = { kind: 'RPC_ERROR', txHash: TX, error: 'down' };
      executor.logs = [
        {
          executionId: order.executionId as Hex,
          owner: order.userAddress as Hex,
          amountIn: parseUnits('0.01', 18),
          amountOut: parseUnits('34.9', 6),
          txHash: TX,
          blockNumber: 11_500_030n,
        },
      ];

      const first = await service.run();
      const second = await service.run();
      const third = await service.run();

      expect(first.backfilled).toBe(1);
      // Corrected once; subsequent passes are no-ops.
      expect(second.backfilled).toBe(0);
      expect(third.backfilled).toBe(0);
      expect(orders.orders.get(order.id)?.status).toBe('EXECUTED');
      expect(orders.orders.get(order.id)?.version).toBe(1);
    });

    it('re-scans the reorg buffer without duplicating corrections', async () => {
      const order = makeOrder({ status: 'EXECUTING', txHash: TX, submittedAt: new Date() });
      orders.add(order);
      monitor.outcome = { kind: 'RPC_ERROR', txHash: TX, error: 'down' };
      executor.logs = [
        {
          executionId: order.executionId as Hex,
          owner: order.userAddress as Hex,
          amountIn: parseUnits('0.01', 18),
          amountOut: parseUnits('34.9', 6),
          txHash: TX,
          blockNumber: 11_500_040n,
        },
      ];

      await service.run();
      await service.run();

      expect(recon.entries.filter((e) => e.kind === 'LOG_BACKFILL')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Failure isolation
  // -------------------------------------------------------------------------
  describe('failure isolation', () => {
    it('runs the remaining passes when the log scan fails', async () => {
      const order = makeOrder({ status: 'FAILED', txHash: TX, submittedAt: new Date() });
      orders.add(order);
      executor.executed.add(order.executionId.toLowerCase());
      executor.logsError = new Error('eth_getLogs timeout');

      const report = await service.run();

      expect(report.errors.some((e) => e.includes('backfillFromLogs'))).toBe(true);
      // The FAILED audit still ran and still corrected the order.
      expect(report.failedButExecuted).toBe(1);
      expect(orders.orders.get(order.id)?.status).toBe('EXECUTED');
    });

    it('reports RPC failure without changing any state', async () => {
      const order = makeOrder({ status: 'EXECUTING', txHash: TX, submittedAt: new Date(0) });
      orders.add(order);
      monitor.outcome = { kind: 'RPC_ERROR', txHash: TX, error: 'ETIMEDOUT' };
      executor.logsError = new Error('rpc down');
      executor.isExecutedError = new Error('rpc down');

      const report = await service.run();

      expect(report.errors.length).toBeGreaterThan(0);
      expect(orders.orders.get(order.id)?.status).toBe('EXECUTING');
    });

    it('does not advance the checkpoint when the scan fails', async () => {
      executor.logsError = new Error('eth_getLogs failed');
      await service.run();
      expect(recon.checkpoint).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // EXECUTED without evidence — logged, never auto-corrected
  // -------------------------------------------------------------------------
  describe('EXECUTED without on-chain evidence', () => {
    it('logs the discrepancy but does NOT change the order', async () => {
      // Flipping EXECUTED back would make the order submittable again. If the
      // reading is wrong — lagging RPC, stale archive node — that is a duplicate
      // trade. A false "executed" is a reporting bug; a false re-execution
      // spends the user's funds twice.
      const order = makeOrder({ status: 'EXECUTED', txHash: TX });
      orders.add(order);
      // executionId NOT consumed on-chain.

      const report = await service.run();

      expect(report.executedWithoutEvidence).toBe(1);
      expect(orders.orders.get(order.id)?.status).toBe('EXECUTED');

      const entry = recon.entries.find((e) => e.kind === 'EXECUTED_NO_EVIDENCE');
      expect(entry?.resolution).toContain('NOT auto-corrected');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown executions
  // -------------------------------------------------------------------------
  describe('unknown executions', () => {
    it('logs a SwapExecuted log with no matching order without fabricating one', async () => {
      executor.logs = [
        {
          executionId: `0x${'ff'.repeat(32)}` as Hex,
          owner: `0x${'11'.repeat(20)}` as Hex,
          amountIn: 1n,
          amountOut: 1n,
          txHash: TX,
          blockNumber: 11_500_050n,
        },
      ];

      const report = await service.run();

      expect(report.backfilled).toBe(0);
      expect(orders.orders.size).toBe(0);
      expect(recon.entries.some((e) => e.discrepancy.includes('unknown executionId'))).toBe(true);
    });
  });
});
