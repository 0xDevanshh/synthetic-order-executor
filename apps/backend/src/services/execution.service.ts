import { getAddress, parseUnits, type Hex } from 'viem';
import type { Order } from '@soe/database';

import { OrderService, orderService } from './order.service.js';
import { resolveToken } from '../config/tokens.js';
import { loadEnv } from '../config/env.js';
import { ConcurrentModificationError, ExecutionError } from '../domain/errors.js';
import {
  getContractClient,
  type ExecuteSwapParams,
  type SyntheticOrderExecutorClient,
} from '../blockchain/contractClient.js';

export interface PreparedExecution {
  order: Order;
  params: ExecuteSwapParams;
  /** Output the simulation says the swap would produce, in base units. */
  simulatedAmountOut: bigint;
}

/**
 * Turns a TRIGGERED order into concrete `executeSwap` calldata and drives the
 * EXECUTING transition.
 *
 * Sits between OrderService and the contract client. Nothing above it deals in
 * base units, deadlines or pool fees; nothing below it knows what an order is.
 *
 * NOTE ON SCOPE: this service prepares, validates and simulates. It does not
 * broadcast, because the API process holds no signing key by design. The worker
 * will call `prepare` and then submit. Splitting it this way means the
 * expensive, revert-prone part is fully testable and fully exercised before a
 * key is ever involved.
 */
export class ExecutionService {
  constructor(
    private readonly orders: OrderService = orderService,
    private readonly contract: () => SyntheticOrderExecutorClient = getContractClient,
  ) {}

  /**
   * Claim a TRIGGERED order and build its execution parameters.
   *
   * Order of operations matters and is deliberate:
   *   1. Claim TRIGGERED -> EXECUTING atomically. If the claim fails, another
   *      worker owns this order; stop immediately.
   *   2. Check `isExecuted` on-chain. Cheap, and it catches the case where a
   *      previous attempt actually landed but the database never learned.
   *   3. Simulate. Every contract revert surfaces here, before gas is spent.
   */
  async prepare(orderId: string): Promise<PreparedExecution> {
    const order = await this.orders.getOrder(orderId);

    const claimed = await this.orders.transition(order, 'EXECUTING');
    if (!claimed) throw new ConcurrentModificationError(orderId);

    try {
      const contract = this.contract();
      const executionId = claimed.executionId as Hex;

      if (await contract.isExecuted(executionId)) {
        throw new ExecutionError(
          'Execution id already consumed on-chain; this order has already executed',
          { executionId },
        );
      }

      const params = this.buildParams(claimed);
      const simulatedAmountOut = await contract.simulateExecuteSwap(params);

      return { order: claimed, params, simulatedAmountOut };
    } catch (error) {
      // Record why, and return the order to a retryable state. Without this the
      // order would sit in EXECUTING forever with no transaction behind it.
      await this.orders.transition(claimed, 'FAILED', {
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
      throw error;
    }
  }

  /**
   * Build `executeSwap` arguments from a stored order.
   *
   * The one piece of real arithmetic in the backend, so it is isolated and unit
   * tested directly:
   *
   *   minAmountOut = amountIn * triggerPrice * (1 - slippageBps/10_000)
   *
   * computed entirely in integer base units. Doing this in floating point would
   * introduce rounding at exactly the boundary the user is protected by, and
   * the contract enforces `amountOut >= minAmountOut` strictly — so a cent of
   * float drift is a revert.
   */
  buildParams(order: Order): ExecuteSwapParams {
    const env = loadEnv();
    const tokenIn = resolveToken(order.tokenIn);
    const tokenOut = resolveToken(order.tokenOut);

    const amountIn = parseUnits(order.amount.toString(), tokenIn.decimals);

    // Price is quoted as tokenOut per tokenIn (USD per ETH for a SELL).
    const priceScaled = parseUnits(order.triggerPrice.toString(), tokenOut.decimals);

    // amountIn is scaled by tokenIn.decimals and price by tokenOut.decimals, so
    // dividing by 10^tokenIn.decimals leaves the result in tokenOut units.
    const expectedOut = (amountIn * priceScaled) / 10n ** BigInt(tokenIn.decimals);

    const slippageBps = BigInt(env.EXECUTION_SLIPPAGE_BPS);
    const minAmountOut = (expectedOut * (10_000n - slippageBps)) / 10_000n;

    const deadline =
      BigInt(Math.floor(Date.now() / 1000)) + BigInt(env.DEADLINE_WINDOW_SEC);

    return {
      executionId: order.executionId as Hex,
      owner: getAddress(order.userAddress),
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      poolFee: env.DEFAULT_POOL_FEE,
      amountIn,
      minAmountOut,
      deadline,
    };
  }

  /** EXECUTING -> EXECUTED once a receipt confirms success. */
  async markExecuted(orderId: string, txHash: string): Promise<Order | null> {
    const order = await this.orders.getOrder(orderId);
    return this.orders.transition(order, 'EXECUTED', { txHash, errorMessage: null });
  }

  /** EXECUTING/TRIGGERED -> FAILED, preserving the tx hash when one exists. */
  async markFailed(
    orderId: string,
    reason: string,
    txHash?: string,
  ): Promise<Order | null> {
    const order = await this.orders.getOrder(orderId);
    return this.orders.transition(order, 'FAILED', {
      errorMessage: reason.slice(0, 500),
      ...(txHash ? { txHash } : {}),
    });
  }
}

export const executionService = new ExecutionService();
