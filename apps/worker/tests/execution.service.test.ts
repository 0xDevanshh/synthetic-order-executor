import { beforeEach, describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import { Prisma } from '@soe/database';

import {
  ExecutionService,
  createTokenRegistry,
} from '../src/execution/execution.service.js';
import { asRepository, FakeOrderRepository, makeOrder, silentLogger } from './helpers/fakes.js';
import {
  asExecutorClient,
  FakeDexAdapter,
  FakeExecutorClient,
  FakeMonitorPipeline,
  testChainConfig,
  WETH,
} from './helpers/chainFakes.js';

describe('ExecutionService', () => {
  let repo: FakeOrderRepository;
  let executor: FakeExecutorClient;
  let dex: FakeDexAdapter;
  let monitorPipeline: FakeMonitorPipeline;
  let service: ExecutionService;

  const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

  beforeEach(() => {
    repo = new FakeOrderRepository();
    executor = new FakeExecutorClient();
    dex = new FakeDexAdapter(executor);
    monitorPipeline = new FakeMonitorPipeline();
    service = new ExecutionService(
      asRepository(repo),
      dex,
      asExecutorClient(executor),
      createTokenRegistry(testChainConfig),
      monitorPipeline,
      silentLogger,
    );
    // Fund the vault so balance pre-flight passes by default.
    executor.setBalance(USER, WETH, parseUnits('1', 18));
  });

  const triggered = () => {
    const order = makeOrder({ status: 'TRIGGERED', userAddress: USER });
    repo.add(order);
    return order;
  };

  describe('happy path', () => {
    it('submits a TRIGGERED order and leaves it EXECUTING for the monitor', async () => {
      const order = triggered();
      const outcome = await service.executeOrder(order.id);

      // SUBMITTED, not EXECUTED. Only a receipt may promote an order to
      // EXECUTED, and only the monitor sees receipts.
      expect(outcome.status).toBe('SUBMITTED');
      expect(outcome.txHash).toBe(executor.txHash);

      const stored = repo.orders.get(order.id);
      expect(stored?.status).toBe('EXECUTING');
      expect(stored?.txHash).toBe(executor.txHash);
      expect(stored?.submittedAt).toBeInstanceOf(Date);
    });

    it('hands the order to the transaction monitor', async () => {
      const order = triggered();
      await service.executeOrder(order.id);

      expect(monitorPipeline.enqueued).toEqual([order.id]);
    });

    it('does not claim an amountOut at submission time', async () => {
      // The settled figure comes from the SwapExecuted event, which does not
      // exist yet. Reporting the quote here would be recording a prediction as
      // if it were fact.
      const order = triggered();
      const outcome = await service.executeOrder(order.id);

      expect(outcome.amountOut).toBeUndefined();
      expect(repo.orders.get(order.id)?.amountOut).toBeNull();
    });

    it('passes the order executionId straight through to the contract', async () => {
      const order = triggered();
      await service.executeOrder(order.id);

      expect(executor.submitted[0]?.executionId).toBe(order.executionId);
    });
  });

  describe('fresh quote', () => {
    it('fetches a quote at execution time rather than trusting the trigger price', async () => {
      const order = triggered();
      await service.executeOrder(order.id);

      expect(dex.quoteRequests).toHaveLength(1);
      expect(dex.quoteRequests[0]?.tokenIn).toBe(WETH);
      expect(dex.quoteRequests[0]?.amountIn).toBe(parseUnits('0.01', 18));
    });

    it('derives minAmountOut from the fresh quote, not the order triggerPrice', async () => {
      // triggerPrice implies ~35 USDC; the live quote says 20. minAmountOut must
      // follow the market, otherwise every execution reverts on slippage.
      const order = makeOrder({
        status: 'TRIGGERED',
        userAddress: USER,
        triggerPrice: new Prisma.Decimal('3500'),
      });
      repo.add(order);
      dex.quotedAmountOut = parseUnits('20', 6);

      await service.executeOrder(order.id);

      expect(executor.submitted[0]?.minAmountOut).toBe(parseUnits('19.8', 6));
    });

    it('fails the order when no liquidity is available', async () => {
      const order = triggered();
      dex.quoteError = new Error('NoLiquidityError: no usable pool');

      const outcome = await service.executeOrder(order.id);

      expect(outcome.status).toBe('FAILED');
      expect(repo.orders.get(order.id)?.status).toBe('FAILED');
      // Nothing was submitted, so no gas was spent discovering this.
      expect(executor.submitted).toHaveLength(0);
    });
  });

  describe('duplicate execution', () => {
    it('refuses an order whose executionId is already consumed on-chain', async () => {
      const order = triggered();
      executor.executed.add(order.executionId.toLowerCase());

      const outcome = await service.executeOrder(order.id);

      expect(outcome.status).toBe('EXECUTED');
      expect(outcome.reason).toContain('already consumed');
      // Critically: it did NOT submit a second transaction.
      expect(executor.submitted).toHaveLength(0);
    });

    it('submits only once when the same order is processed twice', async () => {
      const order = triggered();

      await service.executeOrder(order.id);
      await service.executeOrder(order.id);

      expect(executor.submitted).toHaveLength(1);
    });

    it('lets only one of two concurrent executions submit', async () => {
      const order = triggered();

      await Promise.all([service.executeOrder(order.id), service.executeOrder(order.id)]);

      expect(executor.submitted).toHaveLength(1);
    });

    it('skips an order that is not TRIGGERED', async () => {
      for (const status of ['PENDING', 'EXECUTING', 'EXECUTED', 'FAILED', 'CANCELLED'] as const) {
        const order = makeOrder({ status, userAddress: USER });
        repo.add(order);

        const outcome = await service.executeOrder(order.id);

        expect(outcome.status).toBe('SKIPPED');
      }
      expect(executor.submitted).toHaveLength(0);
    });
  });

  describe('pre-flight checks', () => {
    it('refuses to execute while the contract is paused', async () => {
      const order = triggered();
      executor.paused = true;

      const outcome = await service.executeOrder(order.id);

      expect(outcome.status).toBe('FAILED');
      expect(outcome.reason).toContain('paused');
      expect(executor.submitted).toHaveLength(0);
    });

    it('refuses when the vault balance is insufficient', async () => {
      const order = triggered();
      executor.setBalance(USER, WETH, parseUnits('0.001', 18));

      const outcome = await service.executeOrder(order.id);

      expect(outcome.status).toBe('FAILED');
      expect(outcome.reason).toContain('insufficient vault balance');
      expect(executor.submitted).toHaveLength(0);
    });
  });

  describe('transaction hash persistence', () => {
    it('persists the tx hash BEFORE broadcasting', async () => {
      // The ordering that makes reconciliation possible: if the process dies
      // right after signing, the database still knows which hash to look for.
      const order = triggered();
      const seen: (string | null)[] = [];

      const originalSubmit = executor.submit.bind(executor);
      executor.submit = async (params, onSigned) => {
        return originalSubmit(params, async (hash) => {
          await onSigned?.(hash);
          seen.push(repo.orders.get(order.id)?.txHash ?? null);
        });
      };

      await service.executeOrder(order.id);

      expect(seen[0]).toBe(executor.txHash);
    });
  });

  describe('failure handling', () => {
    it('leaves a reverted transaction to the monitor rather than judging it here', async () => {
      // This service never sees a receipt, so it cannot know a transaction
      // reverted. Resolving that is the monitor's job.
      const order = triggered();

      const outcome = await service.executeOrder(order.id);

      expect(outcome.status).toBe('SUBMITTED');
      expect(repo.orders.get(order.id)?.status).toBe('EXECUTING');
      expect(monitorPipeline.enqueued).toEqual([order.id]);
    });

    it('leaves the order EXECUTING and defers to the monitor when the call throws after signing', async () => {
      // An RPC error after signing says nothing about whether the transaction
      // landed. Concluding FAILED here would be a guess, and a guess that
      // invites a duplicate retry.
      const order = triggered();
      executor.throwOnExecute = new Error('socket hang up');

      const outcome = await service.executeOrder(order.id);

      expect(outcome.status).toBe('SUBMITTED');
      expect(repo.orders.get(order.id)?.status).toBe('EXECUTING');
      expect(monitorPipeline.enqueued).toEqual([order.id]);
    });

    it('leaves the order EXECUTING for the sweep when even the monitor handoff fails', async () => {
      const order = triggered();
      executor.throwOnExecute = new Error('socket hang up');
      monitorPipeline.error = new Error('redis down');

      const outcome = await service.executeOrder(order.id);

      expect(outcome.status).toBe('SUBMITTED');
      expect(repo.orders.get(order.id)?.status).toBe('EXECUTING');
    });

    it('handles a missing order without throwing', async () => {
      const outcome = await service.executeOrder('does-not-exist');
      expect(outcome.status).toBe('SKIPPED');
    });
  });
});
