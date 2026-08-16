import { beforeEach, describe, expect, it } from 'vitest';
import { parseUnits, type Hex } from 'viem';

import { ExecutionService, createTokenRegistry } from '../src/execution/execution.service.js';
import { TxMonitorService } from '../src/monitor/txMonitor.service.js';
import { ReconcilerService } from '../src/reconcile/reconciler.service.js';
import { asRepository, FakeOrderRepository, makeOrder, silentLogger } from './helpers/fakes.js';
import {
  asExecutorClient,
  asMonitor,
  FakeDexAdapter,
  FakeExecutorClient,
  FakeMonitorPipeline,
  FakeReconciliationRepository,
  FakeTransactionMonitor,
  testChainConfig,
  WETH,
} from './helpers/chainFakes.js';

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const TX: Hex = `0x${'ab'.repeat(32)}`;

/**
 * Database failures around transaction submission.
 *
 * The database and the chain fail independently, and the window between them is
 * where duplicate execution lives. These tests pin the behaviour on both sides
 * of the broadcast.
 */
describe('database failure around submission', () => {
  let repo: FakeOrderRepository;
  let executor: FakeExecutorClient;
  let dex: FakeDexAdapter;
  let monitorPipeline: FakeMonitorPipeline;
  let execution: ExecutionService;

  beforeEach(() => {
    repo = new FakeOrderRepository();
    executor = new FakeExecutorClient();
    dex = new FakeDexAdapter(executor);
    monitorPipeline = new FakeMonitorPipeline();
    execution = new ExecutionService(
      asRepository(repo),
      dex,
      asExecutorClient(executor),
      createTokenRegistry(testChainConfig),
      monitorPipeline,
      silentLogger,
    );
    executor.setBalance(USER, WETH, parseUnits('1', 18));
  });

  const triggered = () => {
    const order = makeOrder({ status: 'TRIGGERED', userAddress: USER });
    repo.add(order);
    return order;
  };

  describe('DB fails BEFORE broadcast', () => {
    it('does not broadcast, leaving no ambiguity at all', async () => {
      // recordTxHash is called inside the pre-broadcast callback. If it throws,
      // the client aborts before sending — the safe failure, since nothing
      // reaches the network and the order can be retried cleanly.
      const order = triggered();
      repo.failRecordTxHash = new Error('neon connection lost');

      const outcome = await execution.executeOrder(order.id);

      expect(outcome.status).not.toBe('EXECUTED');
      expect(executor.broadcastCount).toBe(0);
    });

    it('fails the order cleanly, with no hash and nothing on the network', async () => {
      const order = triggered();
      repo.failRecordTxHash = new Error('neon connection lost');

      await execution.executeOrder(order.id);

      // FAILED is correct here, and safe. The transaction was signed but never
      // broadcast, and a signed-but-unbroadcast transaction is inert — it
      // exists only in memory that has already been discarded. No on-chain
      // evidence is needed to conclude nothing happened.
      const stored = repo.orders.get(order.id);
      expect(stored?.status).toBe('FAILED');
      expect(stored?.txHash).toBeNull();
      expect(executor.broadcastCount).toBe(0);
    });

    it('leaves no executionId consumed, so the order is safe to re-trigger', async () => {
      const order = triggered();
      repo.failRecordTxHash = new Error('neon connection lost');

      await execution.executeOrder(order.id);

      expect(await executor.isExecuted(order.executionId as Hex)).toBe(false);
    });
  });

  describe('DB fails AFTER broadcast', () => {
    it('keeps the order EXECUTING when the confirmation write fails', async () => {
      // The transaction landed but the database could not record it. The order
      // must NOT be marked FAILED — that would be a lie, and would invite a
      // retry of a trade the user already paid for.
      const order = makeOrder({
        status: 'EXECUTING',
        userAddress: USER,
        txHash: TX,
        submittedAt: new Date(),
      });
      repo.add(order);
      repo.failMarkConfirmed = new Error('neon write timeout');

      const monitor = new FakeTransactionMonitor();
      const monitorService = new TxMonitorService(
        asRepository(repo),
        asMonitor(monitor),
        silentLogger,
      );

      await expect(monitorService.check(order.id)).rejects.toThrow('neon write timeout');
      expect(repo.orders.get(order.id)?.status).toBe('EXECUTING');
    });

    it('is repaired by the reconciler on the next pass', async () => {
      // This is exactly the case reconciliation exists for: the chain succeeded
      // and the database update failed.
      const order = makeOrder({
        status: 'EXECUTING',
        userAddress: USER,
        txHash: TX,
        submittedAt: new Date(Date.now() - 600_000),
      });
      repo.add(order);
      repo.failMarkConfirmed = new Error('neon write timeout');

      const monitor = new FakeTransactionMonitor();
      const recon = new FakeReconciliationRepository();
      const reconciler = new ReconcilerService(
        asRepository(repo),
        recon as never,
        asExecutorClient(executor),
        new TxMonitorService(asRepository(repo), asMonitor(monitor), silentLogger),
        silentLogger,
      );

      // First pass: the sweep still cannot write, but the log backfill can.
      executor.logs = [
        {
          executionId: order.executionId as Hex,
          owner: USER,
          amountIn: parseUnits('0.01', 18),
          amountOut: parseUnits('34.9', 6),
          txHash: TX,
          blockNumber: 11_500_000n,
        },
      ];

      const first = await reconciler.run();
      expect(first.backfilled).toBe(1);
      expect(repo.orders.get(order.id)?.status).toBe('EXECUTED');

      // Second pass converges: nothing left to correct.
      const second = await reconciler.run();
      expect(second.backfilled).toBe(0);
    });
  });

  describe('DB fails during the claim', () => {
    it('does not submit anything when the claim write fails', async () => {
      // The claim is the gate. If it cannot be written, the order was never
      // ours to execute, so nothing may be signed or sent. The call rejects
      // rather than resolving — an unwritable database is a genuine fault, and
      // BullMQ retrying it is safe precisely because nothing was submitted.
      const order = triggered();
      repo.failTransition = new Error('neon connection lost');

      await expect(execution.executeOrder(order.id)).rejects.toThrow('neon connection lost');

      expect(executor.submitted).toHaveLength(0);
      expect(executor.broadcastCount).toBe(0);
    });
  });
});
