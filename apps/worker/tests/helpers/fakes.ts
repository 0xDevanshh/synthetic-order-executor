import { Prisma, type Order, type OrderSide, type OrderStatus } from '@soe/database';
import type { OrderRepository } from '@soe/core';

import type { PriceProvider, PriceQuote } from '../../src/price/PriceProvider.js';
import type { ExecutionPipeline } from '../../src/trigger/triggerEngine.js';
import type { Logger } from '../../src/lib/logger.js';

let seq = 0;

export function makeOrder(overrides: Partial<Order> = {}): Order {
  seq += 1;
  const now = new Date();
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    userAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    tokenIn: 'ETH',
    tokenOut: 'USDC',
    side: 'SELL' as OrderSide,
    amount: new Prisma.Decimal('0.01'),
    triggerPrice: new Prisma.Decimal('3500'),
    status: 'PENDING' as OrderStatus,
    executionId: `0x${seq.toString(16).padStart(64, '0')}`,
    txHash: null,
    errorMessage: null,
    version: 0,
    submittedAt: null,
    confirmedAt: null,
    blockNumber: null,
    gasUsed: null,
    amountOut: null,
    monitorAttempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Price provider a test can steer directly. */
export class FakePriceProvider implements PriceProvider {
  readonly name = 'fake';
  error: Error | undefined;

  constructor(
    private price: string = '3500',
    private observedAt: Date = new Date(),
  ) {}

  set(price: string, observedAt = new Date()): void {
    this.price = price;
    this.observedAt = observedAt;
  }

  supports(): boolean {
    return true;
  }

  async getPrice(asset: string): Promise<PriceQuote> {
    if (this.error) throw this.error;
    return { asset, price: this.price, source: this.name, observedAt: this.observedAt };
  }
}

/**
 * In-memory repository with the SAME compare-and-swap semantics as the real
 * one — returning null when (status, version) does not match. That behaviour is
 * exactly what the duplicate-trigger tests depend on, so the fake reproducing it
 * faithfully is what makes those tests meaningful.
 */
export class FakeOrderRepository {
  orders = new Map<string, Order>();
  /** Force the next N transitions to lose their race, simulating a competitor. */
  stealNext = 0;

  add(...orders: Order[]): void {
    for (const o of orders) this.orders.set(o.id, o);
  }

  async findTriggerable(price: Prisma.Decimal | string, limit = 100): Promise<Order[]> {
    const p = new Prisma.Decimal(price.toString());
    return [...this.orders.values()]
      .filter(
        (o) =>
          o.status === 'PENDING' &&
          ((o.side === 'SELL' && o.triggerPrice.gte(p)) ||
            (o.side === 'BUY' && o.triggerPrice.lte(p))),
      )
      .slice(0, limit);
  }

  async recordTxHash(id: string, txHash: string): Promise<Order | null> {
    const order = this.orders.get(id);
    if (!order || order.status !== 'EXECUTING') return null;
    const updated: Order = { ...order, txHash, submittedAt: new Date(), updatedAt: new Date() };
    this.orders.set(id, updated);
    return updated;
  }

  async markConfirmed(params: {
    id: string;
    txHash: string;
    blockNumber: bigint;
    gasUsed: bigint;
    amountOut?: bigint;
  }): Promise<Order | null> {
    const order = this.orders.get(params.id);
    if (!order || order.status !== 'EXECUTING') return null;
    const updated: Order = {
      ...order,
      status: 'EXECUTED',
      txHash: params.txHash,
      blockNumber: params.blockNumber,
      gasUsed: params.gasUsed,
      amountOut:
        params.amountOut !== undefined ? new Prisma.Decimal(params.amountOut.toString()) : null,
      confirmedAt: new Date(),
      errorMessage: null,
      version: order.version + 1,
      updatedAt: new Date(),
    };
    this.orders.set(params.id, updated);
    return updated;
  }

  async markFailed(params: {
    id: string;
    errorMessage: string;
    txHash?: string;
    blockNumber?: bigint;
    gasUsed?: bigint;
  }): Promise<Order | null> {
    const order = this.orders.get(params.id);
    if (!order || order.status !== 'EXECUTING') return null;
    const updated: Order = {
      ...order,
      status: 'FAILED',
      errorMessage: params.errorMessage.slice(0, 500),
      ...(params.txHash ? { txHash: params.txHash } : {}),
      ...(params.blockNumber !== undefined ? { blockNumber: params.blockNumber } : {}),
      ...(params.gasUsed !== undefined ? { gasUsed: params.gasUsed } : {}),
      confirmedAt: new Date(),
      version: order.version + 1,
      updatedAt: new Date(),
    };
    this.orders.set(params.id, updated);
    return updated;
  }

  async incrementMonitorAttempts(id: string): Promise<void> {
    const order = this.orders.get(id);
    if (order) this.orders.set(id, { ...order, monitorAttempts: order.monitorAttempts + 1 });
  }

  async findStuckExecuting(olderThanMs: number, limit = 50): Promise<Order[]> {
    const cutoff = Date.now() - olderThanMs;
    return [...this.orders.values()]
      .filter((o) => o.status === 'EXECUTING' && o.submittedAt !== null && o.submittedAt.getTime() < cutoff)
      .slice(0, limit);
  }

  async transitionStatus(params: {
    id: string;
    expectedStatus: OrderStatus;
    expectedVersion: number;
    nextStatus: OrderStatus;
    txHash?: string | null;
    errorMessage?: string | null;
  }): Promise<Order | null> {
    if (this.stealNext > 0) {
      this.stealNext -= 1;
      const victim = this.orders.get(params.id);
      if (victim) this.orders.set(params.id, { ...victim, version: victim.version + 1 });
      return null;
    }

    const order = this.orders.get(params.id);
    if (!order) return null;
    if (order.status !== params.expectedStatus) return null;
    if (order.version !== params.expectedVersion) return null;

    const updated: Order = {
      ...order,
      status: params.nextStatus,
      version: order.version + 1,
      ...(params.txHash !== undefined ? { txHash: params.txHash } : {}),
      ...(params.errorMessage !== undefined ? { errorMessage: params.errorMessage } : {}),
      updatedAt: new Date(),
    };
    this.orders.set(params.id, updated);
    return updated;
  }

  async findById(id: string): Promise<Order | null> {
    return this.orders.get(id) ?? null;
  }

  async findByExecutionId(executionId: string): Promise<Order | null> {
    return (
      [...this.orders.values()].find(
        (o) => o.executionId.toLowerCase() === executionId.toLowerCase(),
      ) ?? null
    );
  }

  async findManyByStatus(status: OrderStatus, limit = 100): Promise<Order[]> {
    return [...this.orders.values()].filter((o) => o.status === status).slice(0, limit);
  }

  async forceExecutedFromReconciliation(params: {
    id: string;
    expectedStatus: OrderStatus;
    txHash?: string;
    blockNumber?: bigint;
    amountOut?: bigint;
    note: string;
  }): Promise<Order | null> {
    const order = this.orders.get(params.id);
    if (!order || order.status !== params.expectedStatus) return null;

    const updated: Order = {
      ...order,
      status: 'EXECUTED',
      ...(params.txHash ? { txHash: params.txHash } : {}),
      ...(params.blockNumber !== undefined ? { blockNumber: params.blockNumber } : {}),
      amountOut:
        params.amountOut !== undefined
          ? new Prisma.Decimal(params.amountOut.toString())
          : order.amountOut,
      confirmedAt: new Date(),
      errorMessage: params.note.slice(0, 500),
      version: order.version + 1,
      updatedAt: new Date(),
    };
    this.orders.set(params.id, updated);
    return updated;
  }
}

export class FakePipeline implements ExecutionPipeline {
  enqueued: string[] = [];
  error: Error | undefined;

  async enqueue(orderId: string): Promise<void> {
    if (this.error) throw this.error;
    this.enqueued.push(orderId);
  }
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function asRepository(fake: FakeOrderRepository): OrderRepository {
  return fake as unknown as OrderRepository;
}
