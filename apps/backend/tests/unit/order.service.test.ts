import { beforeEach, describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';

import { OrderService } from '../../src/services/order.service.js';
import type { OrderRepository } from '@soe/core';
import { deriveExecutionId } from '@soe/core';
import {
  ContractPausedError,
  InvalidTransitionError,
  OrderNotFoundError,
  TokenNotSupportedError,
  TradeTooLargeError,
  ValidationError,
} from '../../src/domain/errors.js';
import {
  FakeContractClient,
  asContractClient,
  FakeOrderRepository,
  USER,
  WETH,
  validOrderInput,
} from '../helpers/fakes.js';

describe('OrderService', () => {
  let repo: FakeOrderRepository;
  let contract: FakeContractClient;
  let service: OrderService;

  beforeEach(() => {
    repo = new FakeOrderRepository();
    contract = new FakeContractClient();
    service = new OrderService(repo as unknown as OrderRepository, () => asContractClient(contract));
  });

  describe('createOrder', () => {
    it('creates a PENDING order with a derived execution id', async () => {
      const order = await service.createOrder(validOrderInput());

      expect(order.status).toBe('PENDING');
      expect(order.tokenIn).toBe('ETH');
      expect(order.tokenOut).toBe('USDC');
      expect(order.amount.toString()).toBe('0.01');
      expect(order.triggerPrice.toString()).toBe('3500');
      expect(order.txHash).toBeNull();
    });

    it('derives the execution id deterministically from the order id', async () => {
      // This is what makes a retry safe: the same order always produces the same
      // executionId, so the contract's replay guard recognises the duplicate.
      const order = await service.createOrder(validOrderInput());
      expect(order.executionId).toBe(deriveExecutionId(order.id));
      expect(order.executionId).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('gives different orders different execution ids', async () => {
      const a = await service.createOrder(validOrderInput());
      const b = await service.createOrder(validOrderInput());
      expect(a.executionId).not.toBe(b.executionId);
    });

    it('checksums the user address', async () => {
      const order = await service.createOrder(
        validOrderInput({ userAddress: USER.toLowerCase() }),
      );
      expect(order.userAddress).toBe(USER);
    });

    it('rejects an unsupported token', async () => {
      await expect(
        service.createOrder(validOrderInput({ tokenIn: 'DOGE' })),
      ).rejects.toThrow(TokenNotSupportedError);
    });

    it('rejects tokenIn == tokenOut', async () => {
      await expect(
        service.createOrder(validOrderInput({ tokenIn: 'ETH', tokenOut: 'WETH' })),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects an order when the contract is paused', async () => {
      contract.paused = true;
      await expect(service.createOrder(validOrderInput())).rejects.toThrow(ContractPausedError);
    });

    it('rejects a token that is not allowlisted on-chain', async () => {
      // Rejected at creation rather than at execution: better a clear 400 now
      // than a confusing revert later.
      contract.allowed.delete(WETH);
      await expect(service.createOrder(validOrderInput())).rejects.toThrow(ValidationError);
    });

    it('rejects an amount above the on-chain max trade size', async () => {
      contract.maxTrade.set(WETH, parseUnits('0.005', 18));
      await expect(service.createOrder(validOrderInput())).rejects.toThrow(TradeTooLargeError);
    });

    it('accepts an amount exactly at the cap', async () => {
      contract.maxTrade.set(WETH, parseUnits('0.01', 18));
      const order = await service.createOrder(validOrderInput());
      expect(order.status).toBe('PENDING');
    });
  });

  describe('getOrder', () => {
    it('throws OrderNotFoundError for an unknown id', async () => {
      await expect(service.getOrder('missing')).rejects.toThrow(OrderNotFoundError);
    });
  });

  describe('listOrders', () => {
    it('filters by user address and status', async () => {
      await service.createOrder(validOrderInput());
      await service.createOrder(
        validOrderInput({ userAddress: '0x1111111111111111111111111111111111111111' }),
      );

      const result = await service.listOrders({
        userAddress: USER,
        limit: 20,
        offset: 0,
      });

      expect(result.total).toBe(1);
      expect(result.orders[0]?.userAddress).toBe(USER);
    });

    it('reports pagination alongside the page', async () => {
      for (let i = 0; i < 3; i += 1) await service.createOrder(validOrderInput());

      const result = await service.listOrders({ limit: 2, offset: 0 });
      expect(result.orders).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.limit).toBe(2);
    });
  });

  describe('cancelOrder', () => {
    it('cancels a PENDING order', async () => {
      const created = await service.createOrder(validOrderInput());
      const cancelled = await service.cancelOrder(created.id);

      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.version).toBe(created.version + 1);
    });

    it('cancels a TRIGGERED order', async () => {
      const created = await service.createOrder(validOrderInput());
      await service.markTriggered(created.id);

      const cancelled = await service.cancelOrder(created.id);
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('refuses to cancel an order already claimed as EXECUTING', async () => {
      const created = await service.createOrder(validOrderInput());
      await service.markTriggered(created.id);
      const triggered = await service.getOrder(created.id);
      await service.transition(triggered, 'EXECUTING');

      await expect(service.cancelOrder(created.id)).rejects.toThrow(InvalidTransitionError);
    });

    it('refuses to cancel twice', async () => {
      const created = await service.createOrder(validOrderInput());
      await service.cancelOrder(created.id);
      await expect(service.cancelOrder(created.id)).rejects.toThrow(InvalidTransitionError);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two concurrent claims win', async () => {
      // The core duplicate-execution defence at the database layer. Both callers
      // read the same (status, version); only one compare-and-swap can match.
      const created = await service.createOrder(validOrderInput());
      await service.markTriggered(created.id);
      const triggered = await service.getOrder(created.id);

      const results = await Promise.all([
        service.transition(triggered, 'EXECUTING'),
        service.transition(triggered, 'EXECUTING'),
      ]);

      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.status).toBe('EXECUTING');
    });

    it('returns null rather than throwing when a claim loses the race', async () => {
      const created = await service.createOrder(validOrderInput());
      await service.markTriggered(created.id);
      const stale = await service.getOrder(created.id);

      await service.transition(stale, 'EXECUTING');
      // Same stale snapshot, now a version behind.
      expect(await service.transition(stale, 'EXECUTING')).toBeNull();
    });

    it('rejects an illegal transition before touching the database', async () => {
      const created = await service.createOrder(validOrderInput());
      await expect(service.transition(created, 'EXECUTED')).rejects.toThrow(
        InvalidTransitionError,
      );
    });
  });
});
