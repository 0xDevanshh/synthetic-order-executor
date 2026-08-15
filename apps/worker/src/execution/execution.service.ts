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
  status: 'EXECUTED' | 'FAILED' | 'SKIPPED';
  txHash?: Hex;
  amountOut?: bigint;
  reason?: string;
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
   *   7. Resolve the receipt
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

      // 6. The hash is persisted by the callback BEFORE broadcast, so a
      //    transaction can never exist that the database has no record of.
      const receipt = await this.dex.execute(params, async (txHash) => {
        await this.orders.recordTxHash(order.id, txHash);
        this.logger.info({ orderId, txHash }, 'transaction signed and recorded pre-broadcast');
      });

      // 7. Resolve.
      const current = await this.orders.findById(order.id);
      if (!current) return { orderId, status: 'SKIPPED', reason: 'order vanished' };

      if (receipt.success) {
        await this.orders.transitionStatus({
          id: order.id,
          expectedStatus: 'EXECUTING',
          expectedVersion: current.version,
          nextStatus: 'EXECUTED',
          txHash: receipt.txHash,
          errorMessage: null,
        });

        this.logger.info(
          {
            orderId,
            txHash: receipt.txHash,
            amountOut: receipt.amountOut?.toString(),
            gasUsed: receipt.gasUsed.toString(),
          },
          'order EXECUTED',
        );

        return {
          orderId,
          status: 'EXECUTED',
          txHash: receipt.txHash,
          amountOut: receipt.amountOut,
        };
      }

      await this.orders.transitionStatus({
        id: order.id,
        expectedStatus: 'EXECUTING',
        expectedVersion: current.version,
        nextStatus: 'FAILED',
        txHash: receipt.txHash,
        errorMessage: (receipt.revertReason ?? 'transaction reverted').slice(0, 500),
      });

      return { orderId, status: 'FAILED', txHash: receipt.txHash, reason: 'reverted' };
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
    if (!current) return { orderId: order.id, status: 'SKIPPED', reason };

    if (current.status === 'EXECUTING') {
      if (await this.executor.isExecuted(order.executionId as Hex)) {
        this.logger.warn(
          { orderId: order.id, err: reason },
          'error after submission but execution landed on-chain; marking EXECUTED',
        );
        await this.orders.transitionStatus({
          id: order.id,
          expectedStatus: 'EXECUTING',
          expectedVersion: current.version,
          nextStatus: 'EXECUTED',
        });
        return { orderId: order.id, status: 'EXECUTED', reason: 'confirmed on-chain' };
      }
    }

    await this.orders.transitionStatus({
      id: order.id,
      expectedStatus: current.status,
      expectedVersion: current.version,
      nextStatus: 'FAILED',
      errorMessage: reason.slice(0, 500),
    });

    this.logger.error({ orderId: order.id, err: reason }, 'execution failed');
    return { orderId: order.id, status: 'FAILED', reason };
  }
}
