import { getAddress, parseUnits, type Address, type Hex } from 'viem';
import type { Order } from '@soe/database';
import { OrderRepository } from '@soe/core';
import type { ChainConfig, DexAdapter, ExecutorContractClient } from '@soe/chain';

import type { Logger } from '../lib/logger.js';

export class ExecutionRejected extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
  ) {
    super(reason);
    this.name = 'ExecutionRejected';
  }
}

export interface ExecutionOutcome {
  orderId: string;
  /**
   * SUBMITTED, not EXECUTED. This service's job ends when the transaction is on
   * the network; only the monitor may declare an order EXECUTED, and only from
   * a receipt.
   */
  status: 'SUBMITTED' | 'EXECUTED' | 'FAILED' | 'SKIPPED';
  txHash?: Hex;
  amountOut?: bigint;
  reason?: string;
}

/** Handoff to the transaction monitor. */
export interface MonitorPipeline {
  enqueue(orderId: string): Promise<void>;
}

/** Symbol -> address/decimals. Mirrors the API's registry. */
export interface TokenRegistry {
  resolve(symbol: string): { address: Address; decimals: number };
}

export function createTokenRegistry(config: ChainConfig): TokenRegistry {
  const table: Record<string, { address: Address; decimals: number }> = {
    ETH: { address: config.weth, decimals: 18 },
    WETH: { address: config.weth, decimals: 18 },
    USDC: { address: config.usdc, decimals: 6 },
  };

  return {
    resolve(symbol: string) {
      const t = table[symbol.toUpperCase()];
      if (!t) throw new ExecutionRejected(`Unsupported token ${symbol}`, false);
      return t;
    },
  };
}

/**
 * Drives a TRIGGERED order through to a submitted transaction.
 *
 * Depends on the DexAdapter interface, never on Uniswap directly — this file
 * contains no fee tier, no router address and no QuoterV2 reference.
 */
export class ExecutionService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly dex: DexAdapter,
    private readonly executor: ExecutorContractClient,
    private readonly tokens: TokenRegistry,
    private readonly monitorPipeline: MonitorPipeline,
    private readonly logger: Logger,
  ) {}

  /**
   * Execute one order. The required sequence, in order, with the reason each
   * step exists:
   *
   *   1. Verify TRIGGERED               — refuse anything else outright
   *   2. Verify executionId unconsumed  — on-chain truth beats the database
   *   3. Fetch a FRESH quote            — never trust the creation-time price
   *   4. Derive minAmountOut            — quote minus slippage
   *   5. Claim TRIGGERED -> EXECUTING   — atomic; loser stands down
   *   6. Sign, persist txHash, broadcast
   *   7. Hand off to the monitor — this service never waits for a receipt
   *
   * Step 2 before step 5 is deliberate: checking the chain first avoids burning
   * a state transition on an order that already settled.
   */
  async executeOrder(orderId: string): Promise<ExecutionOutcome> {
    const order = await this.orders.findById(orderId);
    if (!order) return { orderId, status: 'SKIPPED', reason: 'order not found' };

    // 1. Only TRIGGERED orders are executable.
    if (order.status !== 'TRIGGERED') {
      this.logger.info(
        { orderId, status: order.status },
        'order is not TRIGGERED; skipping execution',
      );
      return { orderId, status: 'SKIPPED', reason: `status is ${order.status}` };
    }

    const executionId = order.executionId as Hex;

    // 2. The authoritative duplicate check. If the chain says this id is spent,
    //    a previous attempt landed and the database simply never learned.
    if (await this.executor.isExecuted(executionId)) {
      this.logger.warn(
        { orderId, executionId },
        'executionId already consumed on-chain; reconciling to EXECUTED',
      );
      await this.orders.transitionStatus({
        id: order.id,
        expectedStatus: 'TRIGGERED',
        expectedVersion: order.version,
        nextStatus: 'EXECUTED',
        errorMessage: 'reconciled: executionId already consumed on-chain',
      });
      return { orderId, status: 'EXECUTED', reason: 'already consumed on-chain' };
    }

    try {
      const state = await this.executor.getState();
      if (state.paused) throw new ExecutionRejected('executor contract is paused', true);

      const tokenIn = this.tokens.resolve(order.tokenIn);
      const tokenOut = this.tokens.resolve(order.tokenOut);
      const amountIn = parseUnits(order.amount.toString(), tokenIn.decimals);
      const owner = getAddress(order.userAddress);

      // Pre-flight the vault balance. The contract enforces this anyway, but
      // failing here costs nothing and produces a far clearer error than a
      // decoded revert.
      const balance = await this.executor.getBalance(owner, tokenIn.address);
      if (balance < amountIn) {
        throw new ExecutionRejected(
          `insufficient vault balance: has ${balance}, needs ${amountIn}`,
          true,
        );
      }

      // 3. FRESH quote. Never the price the order was created at.
      const quote = await this.dex.getQuote({
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn,
      });

      // 4 + slippage + deadline.
      const params = this.dex.buildExecutionParams({ executionId, owner, quote });

      this.logger.info(
        {
          orderId,
          quotedOut: quote.amountOut.toString(),
          minAmountOut: params.minAmountOut.toString(),
          poolFee: params.poolFee,
          deadline: params.deadline.toString(),
        },
        'fresh quote obtained; submitting execution',
      );

      // 5. Atomic claim. Only now does the order leave TRIGGERED.
      const claimed = await this.orders.transitionStatus({
        id: order.id,
        expectedStatus: 'TRIGGERED',
        expectedVersion: order.version,
        nextStatus: 'EXECUTING',
      });

      if (!claimed) {
        this.logger.info({ orderId }, 'order claimed by another worker; standing down');
        return { orderId, status: 'SKIPPED', reason: 'claimed by another worker' };
      }

      // 6. Sign, persist the hash pre-broadcast, then broadcast. Returns as
      //    soon as the transaction is on the network — waiting for a receipt is
      //    the monitor's job, and blocking here would tie up the executor's
      //    single nonce sequence for minutes per order.
      const txHash = await this.dex.submit(params, async (signedHash) => {
        await this.orders.recordTxHash(order.id, signedHash);
        this.logger.info(
          {
            orderId,
            executionId,
            txHash: signedHash,
            status: 'EXECUTING',
            error: null,
          },
          'transaction signed and recorded pre-broadcast',
        );
      });

      this.logger.info(
        { orderId, executionId, txHash, status: 'EXECUTING', error: null },
        'transaction broadcast; handing off to monitor',
      );

      // 7. Hand off. The order stays EXECUTING until the monitor resolves it.
      await this.monitorPipeline.enqueue(order.id);

      return { orderId, status: 'SUBMITTED', txHash };
    } catch (error) {
      return this.handleFailure(order, error);
    }
  }

  /**
   * Record a failure without ever asserting more than we know.
   *
   * An order that already reached EXECUTING may have a transaction in flight, so
   * its state is resolved from the chain rather than guessed at here — marking
   * it FAILED on a local exception would be a lie if the swap subsequently
   * lands.
   */
  private async handleFailure(order: Order, error: unknown): Promise<ExecutionOutcome> {
    const reason = error instanceof Error ? error.message : String(error);
    const current = await this.orders.findById(order.id);
    const base = { orderId: order.id, executionId: order.executionId };

    if (!current) return { orderId: order.id, status: 'SKIPPED', reason };

    // A transaction hash exists, so something may be on the network. This is
    // exactly the ambiguity the monitor is built to resolve, and the ONE thing
    // this method must never do is guess. The order stays EXECUTING and is
    // handed to the monitor, which will consult the chain before concluding
    // anything.
    if (current.status === 'EXECUTING' && current.txHash) {
      this.logger.warn(
        { ...base, txHash: current.txHash, status: 'EXECUTING', error: reason },
        'error after signing; transaction may be live — deferring to monitor',
      );

      try {
        await this.monitorPipeline.enqueue(order.id);
      } catch (enqueueError) {
        // Even the handoff failed. The sweep over stuck EXECUTING orders is the
        // backstop, which is precisely why that sweep exists.
        this.logger.error(
          {
            ...base,
            txHash: current.txHash,
            status: 'EXECUTING',
            error: String(enqueueError),
          },
          'could not enqueue monitor; order left for the stuck sweep',
        );
      }

      return { orderId: order.id, status: 'SUBMITTED', txHash: current.txHash as Hex, reason };
    }

    // No hash was ever recorded, so nothing was signed and nothing can be on the
    // network. Failing the order here is safe, and the order returns to a
    // retryable state.
    await this.orders.transitionStatus({
      id: order.id,
      expectedStatus: current.status,
      expectedVersion: current.version,
      nextStatus: 'FAILED',
      errorMessage: reason.slice(0, 500),
    });

    this.logger.error(
      { ...base, txHash: null, status: 'FAILED', error: reason },
      'execution failed before any transaction was signed',
    );

    return { orderId: order.id, status: 'FAILED', reason };
  }
}
