import { isTriggered, type OrderRepository } from '@soe/core';
import type { Order } from '@soe/database';

import type { PriceQuote } from '../price/PriceProvider.js';
import type { PriceService } from '../price/price.service.js';
import type { Logger } from '../lib/logger.js';

/**
 * Handoff to the execution pipeline.
 *
 * An interface rather than a BullMQ Queue so the engine can be tested without
 * Redis, and so the pipeline could later be a different transport without
 * touching trigger logic.
 */
export interface ExecutionPipeline {
  /**
   * Hand a TRIGGERED order to the execution pipeline.
   * MUST be idempotent on orderId — the engine may enqueue the same order twice
   * across a crash, and the pipeline is expected to dedupe.
   */
  enqueue(orderId: string): Promise<void>;
}

export interface TriggerRunResult {
  price: string;
  source: string;
  /** Orders whose condition the price satisfied. */
  candidates: number;
  /** Orders this run actually moved PENDING -> TRIGGERED. */
  triggered: string[];
  /** Candidates another actor claimed first. Expected, not an error. */
  skipped: number;
  /** Orders triggered but not handed off, so they need a retry. */
  handoffFailures: string[];
}

/**
 * The off-chain trigger engine.
 *
 * Deliberately free of BullMQ, Redis and viem: it takes a price service, a
 * repository and a pipeline, and it is fully exercisable in memory. The worker
 * file is a thin adapter around it.
 *
 * It never submits a blockchain transaction. Its entire job is deciding WHEN,
 * and it hands off to the execution pipeline the moment an order is claimed.
 */
export class TriggerEngine {
  constructor(
    private readonly prices: PriceService,
    private readonly orders: OrderRepository,
    private readonly pipeline: ExecutionPipeline,
    private readonly logger: Logger,
    private readonly batchSize = 100,
  ) {}

  /**
   * One evaluation pass.
   *
   *   1. Fetch a validated price (throws if untrusted — no orders fire).
   *   2. Load PENDING orders the price could satisfy.
   *   3. Re-check the condition in application code.
   *   4. Atomically claim PENDING -> TRIGGERED, one order at a time.
   *   5. Hand each claimed order to the execution pipeline.
   */
  async run(asset = 'ETH/USD'): Promise<TriggerRunResult> {
    const quote = await this.prices.getValidatedPrice(asset);

    const candidates = await this.orders.findTriggerable(quote.price, this.batchSize);

    const result: TriggerRunResult = {
      price: quote.price,
      source: quote.source,
      candidates: candidates.length,
      triggered: [],
      skipped: 0,
      handoffFailures: [],
    };

    for (const order of candidates) {
      // The SQL filter and this predicate must agree. Re-checking in code is not
      // redundant: it is the assertion that keeps a hand-written query from
      // silently disagreeing with the domain rule, and `isTriggered` is the one
      // definition both the tests and the engine share.
      if (!isTriggered(order.side, order.triggerPrice, quote.price)) {
        this.logger.warn(
          { orderId: order.id, side: order.side, triggerPrice: order.triggerPrice.toString() },
          'query returned an order that does not satisfy the trigger; skipping',
        );
        continue;
      }

      const claimed = await this.claim(order, quote);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      result.triggered.push(order.id);

      try {
        await this.pipeline.enqueue(order.id);
      } catch (error) {
        // The order is TRIGGERED in the database but was not handed off. It is
        // NOT rolled back to PENDING: the trigger condition genuinely was met,
        // and reverting would re-fire it later at a different price. Recovery is
        // a sweep for TRIGGERED orders with no execution attempt, which is the
        // reconciler's job.
        result.handoffFailures.push(order.id);
        this.logger.error(
          { orderId: order.id, err: error },
          'order triggered but handoff to execution pipeline failed; awaiting sweep',
        );
      }
    }

    this.logger.info(
      {
        asset,
        price: quote.price,
        source: quote.source,
        candidates: result.candidates,
        triggered: result.triggered.length,
        skipped: result.skipped,
      },
      'trigger evaluation complete',
    );

    return result;
  }

  /**
   * Atomic PENDING -> TRIGGERED.
   *
   * The (status, version) predicate is what prevents duplicate triggering. Two
   * watchers evaluating the same tick both attempt this; exactly one update
   * matches. The loser gets null and stands down — no lock, no coordination.
   */
  private async claim(order: Order, quote: PriceQuote): Promise<Order | null> {
    const claimed = await this.orders.transitionStatus({
      id: order.id,
      expectedStatus: 'PENDING',
      expectedVersion: order.version,
      nextStatus: 'TRIGGERED',
    });

    if (!claimed) {
      this.logger.debug(
        { orderId: order.id },
        'order was claimed by another watcher or changed state; skipping',
      );
      return null;
    }

    this.logger.info(
      {
        orderId: order.id,
        side: order.side,
        triggerPrice: order.triggerPrice.toString(),
        marketPrice: quote.price,
        source: quote.source,
        executionId: claimed.executionId,
      },
      'order TRIGGERED',
    );

    return claimed;
  }
}
