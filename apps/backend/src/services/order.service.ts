import { randomUUID } from 'node:crypto';
import { getAddress, parseUnits } from 'viem';
import type { Order, OrderStatus } from '@soe/database';

import { OrderRepository, orderRepository } from '@soe/core';
import { deriveExecutionId } from '@soe/core';
import { canTransition, isUserCancellable } from '@soe/core';
import {
  ContractPausedError,
  InvalidTransitionError,
  OrderNotFoundError,
  TradeTooLargeError,
  ValidationError,
} from '../domain/errors.js';
import { resolveToken } from '../config/tokens.js';
import {
  getContractClient,
  type SyntheticOrderExecutorClient,
} from '../blockchain/contractClient.js';
import type { CreateOrderInput, ListOrdersQuery } from '../api/schemas/order.schema.js';

/**
 * Order use-cases. Owns validation and state-transition policy.
 *
 * Deliberately knows nothing about HTTP (no req/res, no status codes beyond the
 * ones carried on domain errors) and nothing about calldata. It sits between
 * the controller and the execution path.
 */
export class OrderService {
  constructor(
    private readonly repo: OrderRepository = orderRepository,
    private readonly contract: () => SyntheticOrderExecutorClient = getContractClient,
  ) {}

  /**
   * Create a PENDING order.
   *
   * Validates against live chain state rather than local assumptions: the
   * allowlist and the size cap are read from the contract, so the API rejects an
   * order the contract would refuse instead of accepting it now and failing
   * mysteriously at execution time. That check costs one RPC round trip and
   * saves a whole class of confusing user-facing failures.
   */
  async createOrder(input: CreateOrderInput): Promise<Order> {
    const userAddress = getAddress(input.userAddress);
    const tokenIn = resolveToken(input.tokenIn);
    const tokenOut = resolveToken(input.tokenOut);

    if (tokenIn.address === tokenOut.address) {
      throw new ValidationError('tokenIn and tokenOut must differ', {
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
      });
    }

    const contract = this.contract();
    const config = await contract.getConfig();
    if (config.paused) throw new ContractPausedError();

    const [inAllowed, outAllowed, maxTradeAmount] = await Promise.all([
      contract.isTokenAllowed(tokenIn.address),
      contract.isTokenAllowed(tokenOut.address),
      contract.getMaxTradeAmount(tokenIn.address),
    ]);

    if (!inAllowed) {
      throw new ValidationError(`Token ${tokenIn.symbol} is not allowlisted on-chain`, {
        token: tokenIn.symbol,
      });
    }
    if (!outAllowed) {
      throw new ValidationError(`Token ${tokenOut.symbol} is not allowlisted on-chain`, {
        token: tokenOut.symbol,
      });
    }

    const amountBaseUnits = parseUnits(input.amount, tokenIn.decimals);
    if (amountBaseUnits > maxTradeAmount) {
      throw new TradeTooLargeError(
        input.amount,
        formatBaseUnits(maxTradeAmount, tokenIn.decimals),
        tokenIn.symbol,
      );
    }

    // The id is minted here rather than by the database so the executionId can
    // be derived from it in the same breath. Both are written atomically, so an
    // order can never exist without its replay key.
    const id = randomUUID();

    return this.repo.create({
      id,
      userAddress,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      side: input.side,
      amount: input.amount,
      triggerPrice: input.triggerPrice,
      executionId: deriveExecutionId(id),
    });
  }

  async getOrder(id: string): Promise<Order> {
    const order = await this.repo.findById(id);
    if (!order) throw new OrderNotFoundError(id);
    return order;
  }

  async listOrders(query: ListOrdersQuery): Promise<{
    orders: Order[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const { orders, total } = await this.repo.list({
      userAddress: query.userAddress ? getAddress(query.userAddress) : undefined,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });

    return { orders, total, limit: query.limit, offset: query.offset };
  }

  /**
   * Cancel an order.
   *
   * Only from PENDING or TRIGGERED. Once an order reaches EXECUTING a
   * transaction may already be in the mempool, and no database write can recall
   * it — cancelling there would leave the record claiming the order is dead
   * while the chain is about to execute it.
   */
  async cancelOrder(id: string): Promise<Order> {
    const order = await this.getOrder(id);

    if (!isUserCancellable(order.status)) {
      throw new InvalidTransitionError(order.status, 'CANCELLED');
    }

    const updated = await this.repo.transitionStatus({
      id,
      expectedStatus: order.status,
      expectedVersion: order.version,
      nextStatus: 'CANCELLED',
    });

    // Lost a race with the trigger evaluator or another cancel. Re-read and
    // report the real state rather than asserting a cancellation that did not
    // happen.
    if (!updated) {
      const current = await this.getOrder(id);
      throw new InvalidTransitionError(current.status, 'CANCELLED');
    }

    return updated;
  }

  /**
   * PENDING -> TRIGGERED. Called by the price watcher once it exists.
   */
  async markTriggered(id: string): Promise<Order | null> {
    const order = await this.getOrder(id);
    if (!canTransition(order.status, 'TRIGGERED')) {
      throw new InvalidTransitionError(order.status, 'TRIGGERED');
    }

    return this.repo.transitionStatus({
      id,
      expectedStatus: order.status,
      expectedVersion: order.version,
      nextStatus: 'TRIGGERED',
    });
  }

  /**
   * Generic guarded transition for the execution path.
   *
   * Returns null when the compare-and-swap did not match, which callers must
   * read as "another worker got there first" rather than as a failure.
   */
  async transition(
    order: Order,
    nextStatus: OrderStatus,
    fields?: { txHash?: string | null; errorMessage?: string | null },
  ): Promise<Order | null> {
    if (!canTransition(order.status, nextStatus)) {
      throw new InvalidTransitionError(order.status, nextStatus);
    }

    return this.repo.transitionStatus({
      id: order.id,
      expectedStatus: order.status,
      expectedVersion: order.version,
      nextStatus,
      ...fields,
    });
  }
}

/** Format base units as a decimal string, for error messages. */
function formatBaseUnits(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export const orderService = new OrderService();
