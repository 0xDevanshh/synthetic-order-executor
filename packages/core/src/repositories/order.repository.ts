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
