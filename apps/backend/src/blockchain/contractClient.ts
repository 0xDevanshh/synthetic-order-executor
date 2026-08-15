import { getAddress, type Address, type Hex } from 'viem';

import { syntheticOrderExecutorAbi } from './abi.js';
import { getPublicClient } from './clients.js';
import { loadEnv } from '../config/env.js';

/**
 * Parameters for one `executeSwap` call, matching the deployed signature.
 *
 * Amounts are bigint base units. Nothing above this layer deals in base units,
 * and nothing below it deals in decimal strings — the conversion happens exactly
 * once, in ExecutionService.
 */
export interface ExecuteSwapParams {
  executionId: Hex;
  owner: Address;
  tokenIn: Address;
  tokenOut: Address;
  poolFee: number;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
}

export interface ContractConfig {
  paused: boolean;
  executor: Address;
  swapRouter: Address;
  weth: Address;
}

/**
 * The ONLY place in the backend that knows how to talk to
 * SyntheticOrderExecutor. Everything above depends on this interface, not on
 * viem or on the ABI.
 *
 * Defining it as an interface is what makes the service layer testable without a
 * chain: the unit suite injects a fake, and no test needs an RPC endpoint.
 *
 * Note there is no `signAndSend` here in the API process. `executeSwap` builds
 * and simulates only — the worker owns broadcasting, because it owns the key.
 */
export interface SyntheticOrderExecutorClient {
  readonly address: Address;

  /** True once this executionId has been consumed on-chain. Replay probe. */
  isExecuted(executionId: Hex): Promise<boolean>;

  isTokenAllowed(token: Address): Promise<boolean>;

  /** Per-token maximum single-trade size, in base units. */
  getMaxTradeAmount(token: Address): Promise<bigint>;

  /** A user's vault balance, in base units. */
  getBalance(user: Address, token: Address): Promise<bigint>;

  getConfig(): Promise<ContractConfig>;

  /**
   * Dry-run `executeSwap` against current chain state.
   *
   * Every revert the contract can produce surfaces here for free, before any
   * gas is spent and before a transaction exists — which is what lets the
   * execution path classify a failure precisely instead of guessing from a
   * receipt.
   */
  simulateExecuteSwap(params: ExecuteSwapParams): Promise<bigint>;
}

class ViemSyntheticOrderExecutorClient implements SyntheticOrderExecutorClient {
  readonly address: Address;

  constructor(address: Address) {
    this.address = address;
  }

  private get contract() {
    return {
      address: this.address,
      abi: syntheticOrderExecutorAbi,
    } as const;
  }

  async isExecuted(executionId: Hex): Promise<boolean> {
    return getPublicClient().readContract({
      ...this.contract,
      functionName: 'isExecuted',
      args: [executionId],
    });
  }

  async isTokenAllowed(token: Address): Promise<boolean> {
    return getPublicClient().readContract({
      ...this.contract,
      functionName: 'allowedToken',
      args: [token],
    });
  }

  async getMaxTradeAmount(token: Address): Promise<bigint> {
    return getPublicClient().readContract({
      ...this.contract,
      functionName: 'maxTradeAmount',
      args: [token],
    });
  }

  async getBalance(user: Address, token: Address): Promise<bigint> {
    return getPublicClient().readContract({
      ...this.contract,
      functionName: 'getBalance',
      args: [user, token],
    });
  }

  async getConfig(): Promise<ContractConfig> {
    const client = getPublicClient();
    const [paused, executor, swapRouter, weth] = await Promise.all([
      client.readContract({ ...this.contract, functionName: 'paused' }),
      client.readContract({ ...this.contract, functionName: 'executor' }),
      client.readContract({ ...this.contract, functionName: 'swapRouter' }),
      client.readContract({ ...this.contract, functionName: 'weth' }),
    ]);
    return { paused, executor, swapRouter, weth };
  }

  async simulateExecuteSwap(params: ExecuteSwapParams): Promise<bigint> {
    const config = await this.getConfig();

    // Simulated from the executor's address: `executeSwap` is role-gated, so
    // simulating as anyone else always reverts with AccessControlUnauthorized
    // and tells us nothing about whether the swap itself would succeed.
    const { result } = await getPublicClient().simulateContract({
      ...this.contract,
      functionName: 'executeSwap',
      account: config.executor,
      args: [
        params.executionId,
        params.owner,
        params.tokenIn,
        params.tokenOut,
        params.poolFee,
        params.amountIn,
        params.minAmountOut,
        params.deadline,
      ],
    });

    return result;
  }
}

let cached: SyntheticOrderExecutorClient | undefined;

export function getContractClient(): SyntheticOrderExecutorClient {
  if (!cached) {
    cached = new ViemSyntheticOrderExecutorClient(
      getAddress(loadEnv().EXECUTOR_CONTRACT_ADDRESS),
    );
  }
  return cached;
}

/** Test seam: inject a fake client, or clear the memoised one. */
export function setContractClient(client: SyntheticOrderExecutorClient | undefined): void {
  cached = client;
}
