import { beforeEach, describe, expect, it } from 'vitest';
import { parseUnits, type Hex } from 'viem';

import { TxMonitorService } from '../src/monitor/txMonitor.service.js';
import { asRepository, FakeOrderRepository, makeOrder, silentLogger } from './helpers/fakes.js';
import { asMonitor, FakeTransactionMonitor } from './helpers/chainFakes.js';

const TX: Hex = `0x${'ab'.repeat(32)}`;

describe('TxMonitorService', () => {
  let repo: FakeOrderRepository;
  let monitor: FakeTransactionMonitor;
  let service: TxMonitorService;

  beforeEach(() => {
    repo = new FakeOrderRepository();
    monitor = new FakeTransactionMonitor();
    service = new TxMonitorService(asRepository(repo), asMonitor(monitor), silentLogger);
  });

  const executing = (overrides = {}) => {
    const order = makeOrder({
      status: 'EXECUTING',
      txHash: TX,
      submittedAt: new Date(Date.now() - 30_000),
      ...overrides,
    });
    repo.add(order);
    return order;
  };

  describe('SUCCESS', () => {
    it('moves EXECUTING -> EXECUTED and records block, gas and amountOut', async () => {
      const order = executing();
      const result = await service.check(order.id);

      expect(result.status).toBe('EXECUTED');

      const stored = repo.orders.get(order.id);
      expect(stored?.status).toBe('EXECUTED');
      expect(stored?.txHash).toBe(TX);
      expect(stored?.blockNumber).toBe(11_500_000n);
      expect(stored?.gasUsed).toBe(210_000n);
      expect(stored?.amountOut?.toString()).toBe(parseUnits('34.9', 6).toString());
      expect(stored?.confirmedAt).toBeInstanceOf(Date);
      expect(stored?.errorMessage).toBeNull();
    });

    it('does not ask to be re-checked', async () => {
      const order = executing();
      expect((await service.check(order.id)).requeue).toBe(false);
    });
  });

  describe('REVERTED', () => {
    it('moves EXECUTING -> FAILED with the decoded revert reason', async () => {
      const order = executing();
      monitor.outcome = {
        kind: 'REVERTED',
        txHash: TX,
        blockNumber: 11_500_001n,
        gasUsed: 45_000n,
        reason: 'SlippageExceeded(34000000, 34650000)',
      };

      const result = await service.check(order.id);

      expect(result.status).toBe('FAILED');
      const stored = repo.orders.get(order.id);
      expect(stored?.status).toBe('FAILED');
      // The decoded custom error, not a generic "reverted".
      expect(stored?.errorMessage).toBe('SlippageExceeded(34000000, 34650000)');
      expect(stored?.txHash).toBe(TX);
      expect(stored?.confirmedAt).toBeInstanceOf(Date);
    });
  });

  describe('PENDING', () => {
    it('leaves the order EXECUTING and asks to be re-checked', async () => {
      const order = executing();
      monitor.outcome = { kind: 'PENDING', txHash: TX, ageMs: 20_000 };

      const result = await service.check(order.id);

      expect(result.status).toBe('PENDING');
      expect(result.requeue).toBe(true);
      // Untouched: a pending transaction is not a failure.
      expect(repo.orders.get(order.id)?.status).toBe('EXECUTING');
    });
  });

  describe('dropped transactions — the duplicate-execution boundary', () => {
    it('marks EXECUTED when the hash vanished but the executionId IS consumed', async () => {
      // Some transaction carrying this execution landed. Marking it FAILED would
      // be wrong AND dangerous: it would invite a retry that duplicates a trade
      // the user has already paid for.
      const order = executing();
      monitor.outcome = { kind: 'DROPPED_BUT_EXECUTED', txHash: TX };

      const result = await service.check(order.id);

      expect(result.status).toBe('EXECUTED');
      expect(repo.orders.get(order.id)?.status).toBe('EXECUTED');
      expect(result.requeue).toBe(false);
    });

    it('marks FAILED only when the executionId is confirmed UNCONSUMED', async () => {
      const order = executing();
      monitor.outcome = { kind: 'DROPPED_NOT_EXECUTED', txHash: TX };

      const result = await service.check(order.id);

      expect(result.status).toBe('FAILED');
      expect(repo.orders.get(order.id)?.errorMessage).toContain('dropped');
      expect(result.requeue).toBe(false);
    });

    it('always consults the executionId, never just the tx hash', async () => {
      const order = executing();
      await service.check(order.id);

      expect(monitor.calls[0]?.executionId).toBe(order.executionId);
      expect(monitor.calls[0]?.txHash).toBe(TX);
    });
  });

  describe('RPC errors', () => {
    it('leaves the order EXECUTING and re-checks — never concludes anything', async () => {
      // The single most important negative case. An unreachable RPC tells us
      // nothing about the transaction; concluding "failed" here is how a system
      // retries an order that actually settled.
      const order = executing();
      monitor.outcome = { kind: 'RPC_ERROR', txHash: TX, error: 'connect ETIMEDOUT' };

      const result = await service.check(order.id);

      expect(result.status).toBe('UNKNOWN');
      expect(result.requeue).toBe(true);
      expect(repo.orders.get(order.id)?.status).toBe('EXECUTING');
      expect(repo.orders.get(order.id)?.errorMessage).toBeNull();
    });

    it('survives repeated RPC failures without ever changing state', async () => {
      const order = executing();
      monitor.outcome = { kind: 'RPC_ERROR', txHash: TX, error: 'ECONNRESET' };

      for (let i = 0; i < 5; i += 1) await service.check(order.id);

      expect(repo.orders.get(order.id)?.status).toBe('EXECUTING');
    });

    it('recovers once the RPC comes back', async () => {
      const order = executing();
      monitor.outcome = { kind: 'RPC_ERROR', txHash: TX, error: 'ETIMEDOUT' };
      await service.check(order.id);

      monitor.outcome = {
        kind: 'SUCCESS',
        txHash: TX,
        blockNumber: 11_500_000n,
        gasUsed: 210_000n,
        amountOut: parseUnits('34.9', 6),
      };
      const result = await service.check(order.id);

      expect(result.status).toBe('EXECUTED');
    });
  });

  describe('edge cases', () => {
    it('fails an EXECUTING order that never got a tx hash', async () => {
      // The process died between claiming and signing. Nothing was broadcast, so
      // this is the one branch that needs no on-chain evidence.
      const order = makeOrder({ status: 'EXECUTING', txHash: null, submittedAt: null });
      repo.add(order);

      const result = await service.check(order.id);

      expect(result.status).toBe('FAILED');
      expect(repo.orders.get(order.id)?.errorMessage).toContain('before signing');
      // It never consulted the chain, because there was nothing to consult about.
      expect(monitor.calls).toHaveLength(0);
    });

    it('skips an order that is already terminal', async () => {
      for (const status of ['EXECUTED', 'FAILED', 'CANCELLED', 'PENDING', 'TRIGGERED'] as const) {
        const order = makeOrder({ status, txHash: TX });
        repo.add(order);

        const result = await service.check(order.id);
        expect(result.status).toBe('SKIPPED');
      }
      expect(monitor.calls).toHaveLength(0);
    });

    it('skips a missing order without throwing', async () => {
      expect((await service.check('nope')).status).toBe('SKIPPED');
    });

    it('never moves an order out of a terminal state', async () => {
      const order = makeOrder({ status: 'EXECUTED', txHash: TX });
      repo.add(order);
      monitor.outcome = { kind: 'DROPPED_NOT_EXECUTED', txHash: TX };

      await service.check(order.id);

      expect(repo.orders.get(order.id)?.status).toBe('EXECUTED');
    });
  });

  describe('structured logging fields', () => {
    it('returns orderId, executionId, txHash, status and error on every path', async () => {
      const order = executing();
      monitor.outcome = { kind: 'RPC_ERROR', txHash: TX, error: 'boom' };

      const result = await service.check(order.id);

      expect(result.orderId).toBe(order.id);
      expect(result.executionId).toBe(order.executionId);
      expect(result.txHash).toBe(TX);
      expect(result.status).toBe('UNKNOWN');
      expect(result.error).toBe('boom');
    });
  });

  describe('stuck sweep', () => {
    it('resolves orders left in EXECUTING by a lost monitor job', async () => {
      const stuck = makeOrder({
        status: 'EXECUTING',
        txHash: TX,
        submittedAt: new Date(Date.now() - 600_000),
      });
      repo.add(stuck);

      const results = await service.sweepStuck(300_000);

      expect(results).toHaveLength(1);
      expect(repo.orders.get(stuck.id)?.status).toBe('EXECUTED');
    });

    it('leaves recently submitted orders alone', async () => {
      const recent = makeOrder({
        status: 'EXECUTING',
        txHash: TX,
        submittedAt: new Date(Date.now() - 10_000),
      });
      repo.add(recent);

      expect(await service.sweepStuck(300_000)).toHaveLength(0);
    });
  });
});
