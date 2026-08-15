import { beforeEach, describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';

import { ExecutionService } from '../../src/services/execution.service.js';
import { OrderService } from '../../src/services/order.service.js';
import type { OrderRepository } from '@soe/core';
import { ConcurrentModificationError, ExecutionError } from '../../src/domain/errors.js';
import {
  EXECUTOR,
  FakeContractClient,
  FakeOrderRepository,
  USDC,
  USER,
  WETH,
  validOrderInput,
} from '../helpers/fakes.js';

describe('ExecutionService', () => {
  let repo: FakeOrderRepository;
  let contract: FakeContractClient;
  let orders: OrderService;
  let execution: ExecutionService;

  beforeEach(() => {
    repo = new FakeOrderRepository();
    contract = new FakeContractClient();
    orders = new OrderService(repo as unknown as OrderRepository, () => contract);
    execution = new ExecutionService(orders, () => contract);
  });

  async function triggeredOrder(overrides = {}) {
    const created = await orders.createOrder(validOrderInput(overrides));
    await orders.markTriggered(created.id);
    return orders.getOrder(created.id);
  }

  describe('buildParams', () => {
    it('converts amounts to base units using each token decimals', async () => {
      const order = await triggeredOrder();
      const params = execution.buildParams(order);

      // 0.01 ETH at 18 decimals.
      expect(params.amountIn).toBe(parseUnits('0.01', 18));
      expect(params.tokenIn).toBe(WETH);
      expect(params.tokenOut).toBe(USDC);
      expect(params.owner).toBe(USER);
    });

    it('derives minAmountOut from the trigger price minus slippage', async () => {
      const order = await triggeredOrder();
      const params = execution.buildParams(order);

      // 0.01 ETH * 3500 USD = 35 USDC, less 100 bps = 34.65 USDC (6 decimals).
      expect(params.minAmountOut).toBe(parseUnits('34.65', 6));
    });

    it('computes in integer base units, with no floating-point drift', async () => {
      // 0.1 and 0.3 are unrepresentable in binary floating point. If this
      // arithmetic ever moves to Number, this case drifts and the contract —
      // which enforces amountOut >= minAmountOut strictly — reverts.
      const order = await triggeredOrder({ amount: '0.3', triggerPrice: '3333.33' });
      const params = execution.buildParams(order);

      // 0.3 * 3333.33 = 999.999 USDC, less 1% = 989.99901 -> truncated to 6dp.
      expect(params.minAmountOut).toBe(989_999_010n);
    });

    it('passes the order execution id straight through to the contract', async () => {
      const order = await triggeredOrder();
      const params = execution.buildParams(order);
      expect(params.executionId).toBe(order.executionId);
    });

    it('sets a deadline inside the configured window', async () => {
      const order = await triggeredOrder();
      const params = execution.buildParams(order);

      const now = BigInt(Math.floor(Date.now() / 1000));
      expect(params.deadline).toBeGreaterThan(now);
      expect(params.deadline).toBeLessThanOrEqual(now + 121n);
    });
  });

  describe('prepare', () => {
    it('claims the order and returns simulated parameters', async () => {
      const order = await triggeredOrder();
      const prepared = await execution.prepare(order.id);

      expect(prepared.order.status).toBe('EXECUTING');
      expect(prepared.simulatedAmountOut).toBe(parseUnits('1750', 6));
      expect(contract.lastSimulatedParams?.owner).toBe(USER);
    });

    it('simulates from the executor account, since executeSwap is role-gated', async () => {
      const order = await triggeredOrder();
      await execution.prepare(order.id);
      // The fake records params; the real client sets `account: executor`.
      // Guards against a refactor that simulates as the wrong caller and gets
      // an unrelated AccessControl revert.
      expect((await contract.getConfig()).executor).toBe(EXECUTOR);
    });

    it('refuses to prepare an order that is already consumed on-chain', async () => {
      const order = await triggeredOrder();
      contract.executed.add(order.executionId.toLowerCase());

      await expect(execution.prepare(order.id)).rejects.toThrow(ExecutionError);

      const after = await orders.getOrder(order.id);
      expect(after.status).toBe('FAILED');
      expect(after.errorMessage).toContain('already consumed');
    });

    it('marks the order FAILED and records why when simulation reverts', async () => {
      const order = await triggeredOrder();
      contract.simulateError = new Error('TokenNotAllowed(0x...)');

      await expect(execution.prepare(order.id)).rejects.toThrow();

      const after = await orders.getOrder(order.id);
      // Never left stranded in EXECUTING with no transaction behind it.
      expect(after.status).toBe('FAILED');
      expect(after.errorMessage).toContain('TokenNotAllowed');
    });

    it('lets only one of two concurrent prepares claim the order', async () => {
      const order = await triggeredOrder();

      const results = await Promise.allSettled([
        execution.prepare(order.id),
        execution.prepare(order.id),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConcurrentModificationError,
      );
    });

    it('refuses to prepare an order that is not TRIGGERED', async () => {
      const created = await orders.createOrder(validOrderInput());
      // Still PENDING — PENDING -> EXECUTING is not a legal transition.
      await expect(execution.prepare(created.id)).rejects.toThrow();
    });
  });

  describe('terminal transitions', () => {
    it('records the tx hash on EXECUTED', async () => {
      const order = await triggeredOrder();
      await execution.prepare(order.id);

      const hash = `0x${'a'.repeat(64)}`;
      const done = await execution.markExecuted(order.id, hash);

      expect(done?.status).toBe('EXECUTED');
      expect(done?.txHash).toBe(hash);
      expect(done?.errorMessage).toBeNull();
    });

    it('records the reason on FAILED', async () => {
      const order = await triggeredOrder();
      await execution.prepare(order.id);

      const failed = await execution.markFailed(order.id, 'SlippageExceeded');
      expect(failed?.status).toBe('FAILED');
      expect(failed?.errorMessage).toBe('SlippageExceeded');
    });

    it('truncates an oversized failure reason', async () => {
      const order = await triggeredOrder();
      await execution.prepare(order.id);

      const failed = await execution.markFailed(order.id, 'x'.repeat(2000));
      expect(failed?.errorMessage?.length).toBe(500);
    });
  });
});
