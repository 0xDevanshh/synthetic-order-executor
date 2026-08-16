import { getAddress, parseUnits, type Address, type Hex } from 'viem';
import { Prisma, type Order, type OrderStatus, type OrderSide } from '@soe/database';

import type { ExecutionParams, ExecutorContractClient } from '@soe/chain';
import type {
  CreateOrderData,
  ListOrderFilters,
} from '@soe/core';

export const WETH = getAddress('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');
export const USDC = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
export const USER = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
export const EXECUTOR = getAddress('0x5177f5d8A906cD03CC2387a1F582E5E486b27314');

/**
 * In-memory stand-in for the contract.
 *
 * Every knob a test needs to drive a branch — paused, allowlist, caps,
 * already-executed, simulation revert — without an RPC endpoint. This is the
 * payoff of depending on the SyntheticOrderExecutorClient interface rather than
 * on viem directly.
 */
export class FakeContractClient {
  readonly address = getAddress('0x34C7244383f129957e631706AA420D5CFF721c35');

  paused = false;
  allowed = new Set<Address>([WETH, USDC]);
  maxTrade = new Map<Address, bigint>([
    [WETH, parseUnits('1', 18)],
    [USDC, parseUnits('5000', 6)],
  ]);
  executed = new Set<string>();
  balances = new Map<string, bigint>();
  simulateResult = parseUnits('1750', 6);
  simulateError: Error | undefined;

  /** Records what the service actually asked the chain to do. */
  lastSimulatedParams: ExecutionParams | undefined;

  async isExecuted(executionId: Hex): Promise<boolean> {
    return this.executed.has(executionId.toLowerCase());
  }

  async isTokenAllowed(token: Address): Promise<boolean> {
    return this.allowed.has(getAddress(token));
  }

  async getMaxTradeAmount(token: Address): Promise<bigint> {
    return this.maxTrade.get(getAddress(token)) ?? 0n;
  }

  async getBalance(user: Address, token: Address): Promise<bigint> {
    return this.balances.get(`${getAddress(user)}:${getAddress(token)}`) ?? 0n;
  }

  async getState() {
    return {
      paused: this.paused,
      executor: EXECUTOR,
      swapRouter: getAddress('0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E'),
      weth: WETH,
    };
  }

  async simulate(params: ExecutionParams): Promise<bigint> {
    this.lastSimulatedParams = params;
    if (this.simulateError) throw this.simulateError;
    return this.simulateResult;
  }
}

/**
 * In-memory order store implementing the same compare-and-swap semantics as the
 * real repository — including returning null when the (status, version)
 * predicate does not match, which is what the concurrency tests exercise.
 */
export class FakeOrderRepository {
  orders = new Map<string, Order>();

  async create(data: CreateOrderData): Promise<Order> {
    const now = new Date();
    const order: Order = {
      id: data.id,
      userAddress: data.userAddress,
      tokenIn: data.tokenIn,
      tokenOut: data.tokenOut,
      side: data.side,
      amount: new Prisma.Decimal(data.amount.toString()),
      triggerPrice: new Prisma.Decimal(data.triggerPrice.toString()),
      status: 'PENDING',
      executionId: data.executionId,
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
    };
    this.orders.set(order.id, order);
    return order;
  }

  async findById(id: string): Promise<Order | null> {
    return this.orders.get(id) ?? null;
  }

  async findByExecutionId(executionId: string): Promise<Order | null> {
    return [...this.orders.values()].find((o) => o.executionId === executionId) ?? null;
  }

  async list(filters: ListOrderFilters): Promise<{ orders: Order[]; total: number }> {
    let all = [...this.orders.values()];
    if (filters.userAddress) all = all.filter((o) => o.userAddress === filters.userAddress);
    if (filters.status) all = all.filter((o) => o.status === filters.status);
    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      orders: all.slice(filters.offset, filters.offset + filters.limit),
      total: all.length,
    };
  }

  async transitionStatus(params: {
    id: string;
    expectedStatus: OrderStatus;
    expectedVersion: number;
    nextStatus: OrderStatus;
    txHash?: string | null;
    errorMessage?: string | null;
  }): Promise<Order | null> {
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

  async findTriggerable(price: Prisma.Decimal | string): Promise<Order[]> {
    const p = new Prisma.Decimal(price.toString());
    return [...this.orders.values()].filter(
      (o) =>
        o.status === 'PENDING' &&
        ((o.side === 'SELL' && o.triggerPrice.gte(p)) ||
          (o.side === 'BUY' && o.triggerPrice.lte(p))),
    );
  }
}

export function validOrderInput(overrides: Partial<Record<string, string>> = {}) {
  return {
    userAddress: USER,
    tokenIn: 'ETH',
    tokenOut: 'USDC',
    side: 'SELL' as OrderSide,
    amount: '0.01',
    triggerPrice: '3500',
    ...overrides,
  };
}

export function asContractClient(fake: FakeContractClient): ExecutorContractClient {
  return fake as unknown as ExecutorContractClient;
}
