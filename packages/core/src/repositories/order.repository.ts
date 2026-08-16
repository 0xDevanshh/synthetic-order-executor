import { Prisma, prisma, type Order, type OrderStatus, type OrderSide } from '@soe/database';

export interface CreateOrderData {
  id: string;
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  side: OrderSide;
  amount: Prisma.Decimal | string;
  triggerPrice: Prisma.Decimal | string;
  executionId: string;
}

export interface ListOrderFilters {
  userAddress?: string;
  status?: OrderStatus;
  limit: number;
  offset: number;
}

/**
 * All order persistence. The only module that issues Prisma queries for orders,
 * so every write goes through the same concurrency discipline.
 */
export class OrderRepository {
  constructor(private readonly db = prisma) {}

  async create(data: CreateOrderData): Promise<Order> {
    return this.db.order.create({ data });
  }

  async findById(id: string): Promise<Order | null> {
    return this.db.order.findUnique({ where: { id } });
  }

  async findByExecutionId(executionId: string): Promise<Order | null> {
    return this.db.order.findUnique({ where: { executionId } });
  }

  async list(filters: ListOrderFilters): Promise<{ orders: Order[]; total: number }> {
    const where = {
      ...(filters.userAddress ? { userAddress: filters.userAddress } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [orders, total] = await Promise.all([
      this.db.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filters.limit,
        skip: filters.offset,
      }),
      this.db.order.count({ where }),
    ]);

    return { orders, total };
  }

  /**
   * Compare-and-swap status transition.
   *
   * The `status` and `version` predicates are the whole point: the update only
   * lands if the row is still exactly as the caller last saw it. Two workers
   * racing the same order both issue this, one matches and one updates zero
   * rows — so the loser learns it lost without any distributed lock.
   *
   * Returns null when the row did not match. Callers must treat null as "stand
   * down", never as an error to retry blindly.
   */
  async transitionStatus(params: {
    id: string;
    expectedStatus: OrderStatus;
    expectedVersion: number;
    nextStatus: OrderStatus;
    txHash?: string | null;
    errorMessage?: string | null;
  }): Promise<Order | null> {
    const result = await this.db.order.updateMany({
      where: {
        id: params.id,
        status: params.expectedStatus,
        version: params.expectedVersion,
      },
      data: {
        status: params.nextStatus,
        version: { increment: 1 },
        ...(params.txHash !== undefined ? { txHash: params.txHash } : {}),
        ...(params.errorMessage !== undefined ? { errorMessage: params.errorMessage } : {}),
      },
    });

    if (result.count === 0) return null;
    return this.findById(params.id);
  }

  /**
   * Record a transaction hash against an order already claimed as EXECUTING.
   *
   * Separate from `transitionStatus` on purpose: this is not a state change, it
   * is attaching evidence to the current state. Routing it through the
   * transition method would mean an EXECUTING -> EXECUTING "transition", which
   * the state machine rightly considers illegal.
   *
   * Called BEFORE the transaction is broadcast, so a transaction can never exist
   * on the network that this database has no record of.
   */
  async recordTxHash(id: string, txHash: string): Promise<Order | null> {
    const result = await this.db.order.updateMany({
      where: { id, status: 'EXECUTING' },
      data: { txHash, submittedAt: new Date() },
    });

    if (result.count === 0) return null;
    return this.findById(id);
  }

  /**
   * EXECUTING -> EXECUTED, with the settled on-chain facts.
   *
   * `amountOut` comes from the SwapExecuted event, never from the quote or the
   * simulation. Recording a prediction as if it were settled is how a book
   * drifts from chain state.
   */
  async markConfirmed(params: {
    id: string;
    txHash: string;
    blockNumber: bigint;
    gasUsed: bigint;
    amountOut?: bigint;
  }): Promise<Order | null> {
    const result = await this.db.order.updateMany({
      where: { id: params.id, status: 'EXECUTING' },
      data: {
        status: 'EXECUTED',
        txHash: params.txHash,
        blockNumber: params.blockNumber,
        gasUsed: params.gasUsed,
        ...(params.amountOut !== undefined
          ? { amountOut: new Prisma.Decimal(params.amountOut.toString()) }
          : {}),
        confirmedAt: new Date(),
        errorMessage: null,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) return null;
    return this.findById(params.id);
  }

  /** EXECUTING -> FAILED, preserving the hash and the decoded reason. */
  async markFailed(params: {
    id: string;
    errorMessage: string;
    txHash?: string;
    blockNumber?: bigint;
    gasUsed?: bigint;
  }): Promise<Order | null> {
    const result = await this.db.order.updateMany({
      where: { id: params.id, status: 'EXECUTING' },
      data: {
        status: 'FAILED',
        errorMessage: params.errorMessage.slice(0, 500),
        ...(params.txHash ? { txHash: params.txHash } : {}),
        ...(params.blockNumber !== undefined ? { blockNumber: params.blockNumber } : {}),
        ...(params.gasUsed !== undefined ? { gasUsed: params.gasUsed } : {}),
        confirmedAt: new Date(),
        version: { increment: 1 },
      },
    });

    if (result.count === 0) return null;
    return this.findById(params.id);
  }

  /** Count a monitor poll. Reads are always safe; this is for observability. */
  async incrementMonitorAttempts(id: string): Promise<void> {
    await this.db.order.updateMany({
      where: { id },
      data: { monitorAttempts: { increment: 1 } },
    });
  }

  /**
   * Orders stuck in EXECUTING longer than `olderThanMs`.
   *
   * The safety net for a monitor job that was lost — a worker crash, a Redis
   * flush, a deploy mid-flight. Without this sweep an order could sit in
   * EXECUTING forever with a settled transaction nobody looked at.
   */
  async findStuckExecuting(olderThanMs: number, limit = 50): Promise<Order[]> {
    return this.db.order.findMany({
      where: {
        status: 'EXECUTING',
        submittedAt: { lt: new Date(Date.now() - olderThanMs) },
      },
      orderBy: { submittedAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Force an order to EXECUTED from a non-EXECUTING state.
   *
   * RECONCILIATION ONLY. This deliberately bypasses the normal state machine,
   * because it exists for exactly one situation: the chain says the execution
   * happened and the database disagrees. The chain wins — a FAILED order whose
   * executionId is provably consumed is a database lie, and leaving it in place
   * would show the user a failure for a trade they actually paid for.
   *
   * Guarded on `expectedStatus` so it is still a compare-and-swap, and every
   * call must be accompanied by a ReconciliationLog entry.
   */
  async forceExecutedFromReconciliation(params: {
    id: string;
    expectedStatus: OrderStatus;
    txHash?: string;
    blockNumber?: bigint;
    amountOut?: bigint;
    note: string;
  }): Promise<Order | null> {
    const result = await this.db.order.updateMany({
      where: { id: params.id, status: params.expectedStatus },
      data: {
        status: 'EXECUTED',
        ...(params.txHash ? { txHash: params.txHash } : {}),
        ...(params.blockNumber !== undefined ? { blockNumber: params.blockNumber } : {}),
        ...(params.amountOut !== undefined
          ? { amountOut: new Prisma.Decimal(params.amountOut.toString()) }
          : {}),
        confirmedAt: new Date(),
        errorMessage: params.note.slice(0, 500),
        version: { increment: 1 },
      },
    });

    if (result.count === 0) return null;
    return this.findById(params.id);
  }

  async findManyByStatus(status: OrderStatus, limit = 100): Promise<Order[]> {
    return this.db.order.findMany({
      where: { status },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Orders eligible for triggering. Used by the price watcher once it exists.
   *
   * SELL fires when the market falls to or below the trigger; BUY when it rises
   * to or above. Comparison is inclusive, matching what the user reads in the
   * UI: "sell at 3500" fires at exactly 3500.
   */
  async findTriggerable(price: Prisma.Decimal | string, limit = 100): Promise<Order[]> {
    return this.db.order.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { side: 'SELL', triggerPrice: { gte: price } },
          { side: 'BUY', triggerPrice: { lte: price } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}

export const orderRepository = new OrderRepository();
