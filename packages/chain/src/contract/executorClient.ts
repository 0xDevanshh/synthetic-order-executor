import {
  encodeFunctionData,
  keccak256,
  parseGwei,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

import { syntheticOrderExecutorAbi } from '../abi/syntheticOrderExecutor.js';
import { createReadClient, createSigningClient } from '../clients.js';
import type { ChainConfig } from '../config.js';
import { NoSignerError, type ExecutionParams } from '../dex/DexAdapter.js';

export interface SwapExecutedLog {
  executionId: Hex;
  owner: Address;
  amountIn: bigint;
  amountOut: bigint;
  txHash: Hex;
  blockNumber: bigint;
}

export interface ExecutorContractState {
  paused: boolean;
  executor: Address;
  swapRouter: Address;
  weth: Address;
}

/**
 * The only module that talks to SyntheticOrderExecutor.
 *
 * Address comes from EXECUTOR_CONTRACT_ADDRESS via ChainConfig; nothing here is
 * hardcoded. Read methods work without a key. Write methods require one and
 * throw NoSignerError when the process has none — the API is expected to hit
 * that path, and it should be loud rather than silent.
 */
export class ExecutorContractClient {
  readonly address: Address;

  private readonly read: PublicClient;
  private readonly signer?: { client: WalletClient; account: Account };

  constructor(
    private readonly config: ChainConfig,
    readClient?: PublicClient,
  ) {
    this.address = config.executorContract;
    this.read = readClient ?? createReadClient(config);
    this.signer = createSigningClient(config);
  }

  get hasSigner(): boolean {
    return Boolean(this.signer);
  }

  get executorAddress(): Address | undefined {
    return this.signer?.account.address;
  }

  private get contract() {
    return { address: this.address, abi: syntheticOrderExecutorAbi } as const;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Has this executionId already been consumed on-chain?
   *
   * The authoritative duplicate-execution check. The database can be wrong; this
   * cannot. Consulted before every submission and again when resolving an
   * ambiguous transaction.
   */
  async isExecuted(executionId: Hex): Promise<boolean> {
    return this.read.readContract({
      ...this.contract,
      functionName: 'isExecuted',
      args: [executionId],
    });
  }

  async isTokenAllowed(token: Address): Promise<boolean> {
    return this.read.readContract({
      ...this.contract,
      functionName: 'allowedToken',
      args: [token],
    });
  }

  async getMaxTradeAmount(token: Address): Promise<bigint> {
    return this.read.readContract({
      ...this.contract,
      functionName: 'maxTradeAmount',
      args: [token],
    });
  }

  async getBalance(user: Address, token: Address): Promise<bigint> {
    return this.read.readContract({
      ...this.contract,
      functionName: 'getBalance',
      args: [user, token],
    });
  }

  async getState(): Promise<ExecutorContractState> {
    const [paused, executor, swapRouter, weth] = await Promise.all([
      this.read.readContract({ ...this.contract, functionName: 'paused' }),
      this.read.readContract({ ...this.contract, functionName: 'executor' }),
      this.read.readContract({ ...this.contract, functionName: 'swapRouter' }),
      this.read.readContract({ ...this.contract, functionName: 'weth' }),
    ]);
    return { paused, executor, swapRouter, weth };
  }

  /**
   * SwapExecuted events in a block range.
   *
   * The reconciler's primary evidence. `executionId` is an indexed topic, so
   * every event maps back to exactly one order with no ambiguity — which is what
   * makes log-driven backfill idempotent: re-scanning the same range produces
   * the same set of executions, and re-applying them is a no-op.
   */
  async getSwapExecutedLogs(fromBlock: bigint, toBlock: bigint): Promise<SwapExecutedLog[]> {
    const logs = await this.read.getContractEvents({
      address: this.address,
      abi: syntheticOrderExecutorAbi,
      eventName: 'SwapExecuted',
      fromBlock,
      toBlock,
    });

    return logs.map((log) => {
      const args = log.args as unknown as {
        executionId: Hex;
        owner: Address;
        amountIn: bigint;
        amountOut: bigint;
      };
      return {
        executionId: args.executionId,
        owner: args.owner,
        amountIn: args.amountIn,
        amountOut: args.amountOut,
        txHash: log.transactionHash as Hex,
        blockNumber: log.blockNumber as bigint,
      };
    });
  }

  async getBlockNumber(): Promise<bigint> {
    return this.read.getBlockNumber();
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * Dry-run executeSwap against current state.
   *
   * Surfaces every contract revert — allowlist, size cap, deadline, slippage,
   * replay — for free, before any gas is spent and before a transaction exists.
   * Simulated from the executor account because executeSwap is role-gated;
   * simulating as anyone else just returns an AccessControl revert and tells us
   * nothing useful.
   */
  async simulate(params: ExecutionParams): Promise<bigint> {
    const account = this.signer?.account.address ?? (await this.getState()).executor;

    const { result } = await this.read.simulateContract({
      ...this.contract,
      functionName: 'executeSwap',
      account,
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

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Sign and broadcast an execution. Returns as soon as the transaction is on
   * the network — it does NOT wait for a receipt.
   *
   * Waiting is the monitor's job. Blocking here would tie up the executor
   * worker (and its single nonce sequence) for minutes per order, and would
   * lose the transaction entirely if the process restarted mid-wait.
   *
   * The ordering below is the most important detail in the execution path:
   *
   *   1. Simulate      — catch reverts before spending anything.
   *   2. Sign LOCALLY  — a signed raw transaction has a deterministic hash,
   *                      known before anyone else has seen it.
   *   3. onSigned(hash) — the caller persists EXECUTING + txHash HERE.
   *   4. Only then broadcast.
   *
   * Doing 4 before 3 leaves a window where a transaction exists on the network
   * that the database has no record of. Die in that window and the order looks
   * unexecuted forever while the swap settles, with no hash to reconcile
   * against. Local signing is what makes the safe ordering possible.
   */
  async submit(
    params: ExecutionParams,
    onSigned?: (txHash: Hex) => Promise<void>,
  ): Promise<Hex> {
    if (!this.signer) throw new NoSignerError();

    const { client, account } = this.signer;

    await this.simulate(params);

    const fees = await this.read.estimateFeesPerGas();
    const maxFeeCap = parseGwei(String(this.config.maxFeePerGasGwei));

    const request = await this.read.prepareTransactionRequest({
      account,
      to: this.address,
      data: this.encodeExecuteSwap(params),
      // Cap the fee. An RPC returning a wild estimate during congestion must
      // not be able to drain the hot wallet's gas budget on one transaction.
      maxFeePerGas: fees.maxFeePerGas > maxFeeCap ? maxFeeCap : fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      chain: null,
    });

    const serialized = await client.signTransaction(request as never);
    const txHash = keccak256(serialized);

    // Persist BEFORE broadcasting. See the note above.
    if (onSigned) await onSigned(txHash);

    return this.read.sendRawTransaction({ serializedTransaction: serialized });
  }

  private encodeExecuteSwap(params: ExecutionParams): Hex {
    return encodeFunctionData({
      abi: syntheticOrderExecutorAbi,
      functionName: 'executeSwap',
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
  }

}
