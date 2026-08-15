import {
  decodeEventLog,
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
import {
  NoSignerError,
  type ExecutionParams,
  type ExecutionReceipt,
} from '../dex/DexAdapter.js';

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
   * Submit an execution.
   *
   * The ordering below is the single most important detail in the whole
   * execution path:
   *
   *   1. Simulate — catch reverts before spending anything.
   *   2. Sign LOCALLY. A signed raw transaction has a deterministic hash, known
   *      before anyone else has seen it.
   *   3. Call `onSubmitted(hash)` — the caller persists EXECUTING + txHash HERE.
   *   4. Only then broadcast.
   *
   * Doing 4 before 3 creates a window where a transaction exists on the network
   * that the database has no record of. If the process dies in that window, the
   * order looks unexecuted forever while the swap actually settles, and
   * reconciliation has no hash to search for. Signing locally is what makes the
   * safe ordering possible at all.
   */
  async execute(
    params: ExecutionParams,
    onSubmitted?: (txHash: Hex) => Promise<void>,
  ): Promise<ExecutionReceipt> {
    if (!this.signer) throw new NoSignerError();

    const { client, account } = this.signer;

    await this.simulate(params);

    const fees = await this.read.estimateFeesPerGas();
    const maxFeeCap = parseGwei(String(this.config.maxFeePerGasGwei));

    const request = await this.read.prepareTransactionRequest({
      account,
      to: this.address,
      data: this.encodeExecuteSwap(params),
      // Cap the fee. An RPC returning a wild estimate during congestion should
      // not be able to drain the hot wallet's gas budget on one transaction.
      maxFeePerGas: fees.maxFeePerGas > maxFeeCap ? maxFeeCap : fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      chain: null,
    });

    const serialized = await client.signTransaction(request as never);
    const txHash = keccak256(serialized);

    // Persist BEFORE broadcasting. See the note above.
    if (onSubmitted) await onSubmitted(txHash);

    const broadcastHash = await this.read.sendRawTransaction({
      serializedTransaction: serialized,
    });

    const receipt = await this.read.waitForTransactionReceipt({
      hash: broadcastHash,
      timeout: 300_000,
    });

    return {
      txHash: broadcastHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      success: receipt.status === 'success',
      amountOut:
        receipt.status === 'success' ? this.decodeAmountOut(receipt.logs) : undefined,
    };
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

  /**
   * Read the ACTUAL output from the SwapExecuted event.
   *
   * Not the quote, and not the simulation — the amount the swap really produced.
   * Recording a predicted number as if it were settled is how books drift from
   * chain state.
   */
  private decodeAmountOut(logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[]):
    | bigint
    | undefined {
    for (const log of logs) {
      if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: syntheticOrderExecutorAbi,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if (decoded.eventName === 'SwapExecuted') {
          return (decoded.args as unknown as { amountOut: bigint }).amountOut;
        }
      } catch {
        // Not one of ours, or an unrelated event. Skip.
      }
    }
    return undefined;
  }
}
