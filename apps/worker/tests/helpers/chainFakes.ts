import { getAddress, parseUnits, type Address, type Hex } from 'viem';
import type {
  TransactionMonitor,
  TransactionOutcome,
  BuildParamsInput,
  ChainConfig,
  DexAdapter,
  DexQuote,
  ExecutionParams,
  ExecutorContractClient,
  SwapExecutedLog,
  QuoteRequest,
} from '@soe/chain';

export const WETH = getAddress('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');
export const USDC = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
export const EXECUTOR_EOA = getAddress('0x5177f5d8A906cD03CC2387a1F582E5E486b27314');
export const CONTRACT = getAddress('0x34C7244383f129957e631706AA420D5CFF721c35');

export const testChainConfig: ChainConfig = {
  chainId: 11155111,
  rpcUrls: ['https://sepolia.example.invalid'],
  executorContract: CONTRACT,
  swapRouter: getAddress('0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E'),
  quoterV2: getAddress('0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3'),
  factory: getAddress('0x0227628f3F023bb0B980b67D528571c95c6DaC1c'),
  feeTiers: [500, 3000, 10000],
  weth: WETH,
  usdc: USDC,
  slippageBps: 100,
  deadlineWindowSec: 120,
  maxFeePerGasGwei: 100,
};

/** Executor client stand-in with every branch a test needs to drive. */
export class FakeExecutorClient {
  paused = false;
  executed = new Set<string>();
  balances = new Map<string, bigint>();
  executorAddress: Address | undefined = EXECUTOR_EOA;
  hasSigner = true;


  /** Set to make execute() throw, as an RPC failure would. */
  throwOnExecute: Error | undefined;
  /** Marks the id consumed on-chain when execute throws, simulating a landed tx. */
  landsDespiteThrow = false;

  submitted: ExecutionParams[] = [];
  txHash: Hex = `0x${'ab'.repeat(32)}`;

  /** Reconciliation surface. */
  logs: SwapExecutedLog[] = [];
  logsError: Error | undefined;
  isExecutedError: Error | undefined;
  isExecutedCalls: Hex[] = [];
  headBlock = 11_500_100n;

  setBalance(user: Address, token: Address, amount: bigint): void {
    this.balances.set(`${getAddress(user)}:${getAddress(token)}`, amount);
  }

  async isExecuted(executionId: Hex): Promise<boolean> {
    this.isExecutedCalls.push(executionId);
    if (this.isExecutedError) throw this.isExecutedError;
    return this.executed.has(executionId.toLowerCase());
  }

  async getBlockNumber(): Promise<bigint> {
    return this.headBlock;
  }

  async getSwapExecutedLogs(): Promise<SwapExecutedLog[]> {
    if (this.logsError) throw this.logsError;
    return this.logs;
  }

  async getBalance(user: Address, token: Address): Promise<bigint> {
    return this.balances.get(`${getAddress(user)}:${getAddress(token)}`) ?? 0n;
  }

  async getState() {
    return {
      paused: this.paused,
      executor: EXECUTOR_EOA,
      swapRouter: testChainConfig.swapRouter,
      weth: WETH,
    };
  }

  async simulate(): Promise<bigint> {
    return parseUnits('34.9', 6);
  }

  async submit(
    params: ExecutionParams,
    onSigned?: (txHash: Hex) => Promise<void>,
  ): Promise<Hex> {
    this.submitted.push(params);

    // Faithful to the real client: the hash is handed over BEFORE broadcast.
    if (onSigned) await onSigned(this.txHash);

    if (this.throwOnExecute) {
      if (this.landsDespiteThrow) this.executed.add(params.executionId.toLowerCase());
      throw this.throwOnExecute;
    }

    this.executed.add(params.executionId.toLowerCase());
    return this.txHash;
  }
}

/** DEX adapter stand-in that records what it was asked for. */
export class FakeDexAdapter implements DexAdapter {
  readonly name = 'fake-dex';

  quotedAmountOut = parseUnits('35', 6);
  poolFee = 3000;
  quoteError: Error | undefined;
  quoteRequests: QuoteRequest[] = [];
  builtParams: ExecutionParams[] = [];

  constructor(private readonly executor: FakeExecutorClient) {}

  async getQuote(request: QuoteRequest): Promise<DexQuote> {
    if (this.quoteError) throw this.quoteError;
    this.quoteRequests.push(request);
    return {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amountIn,
      amountOut: this.quotedAmountOut,
      poolFee: this.poolFee,
      gasEstimate: 150_000n,
      quotedAt: new Date(),
    };
  }

  buildExecutionParams(input: BuildParamsInput): ExecutionParams {
    const params: ExecutionParams = {
      executionId: input.executionId,
      owner: input.owner,
      tokenIn: input.quote.tokenIn,
      tokenOut: input.quote.tokenOut,
      poolFee: input.quote.poolFee,
      amountIn: input.quote.amountIn,
      minAmountOut: (input.quote.amountOut * 9_900n) / 10_000n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 120n,
    };
    this.builtParams.push(params);
    return params;
  }

  async submit(params: ExecutionParams, onSigned?: (txHash: Hex) => Promise<void>): Promise<Hex> {
    return this.executor.submit(params, onSigned);
  }
}

export function asExecutorClient(fake: FakeExecutorClient): ExecutorContractClient {
  return fake as unknown as ExecutorContractClient;
}

/** Monitor stand-in: tests set the outcome and assert what the service does. */
export class FakeTransactionMonitor {
  outcome: TransactionOutcome = {
    kind: 'SUCCESS',
    txHash: `0x${'ab'.repeat(32)}` as Hex,
    blockNumber: 11_500_000n,
    gasUsed: 210_000n,
    amountOut: parseUnits('34.9', 6),
  };

  calls: { txHash: Hex; executionId: Hex }[] = [];

  async getOutcome(txHash: Hex, executionId: Hex): Promise<TransactionOutcome> {
    this.calls.push({ txHash, executionId });
    return this.outcome;
  }
}

export class FakeMonitorPipeline {
  enqueued: string[] = [];
  error: Error | undefined;

  async enqueue(orderId: string): Promise<void> {
    if (this.error) throw this.error;
    this.enqueued.push(orderId);
  }
}

export function asMonitor(fake: FakeTransactionMonitor): TransactionMonitor {
  return fake as unknown as TransactionMonitor;
}

/** In-memory checkpoint + audit trail for reconciliation tests. */
export class FakeReconciliationRepository {
  checkpoint: bigint | null = null;
  entries: {
    orderId?: string;
    kind: string;
    discrepancy: string;
    resolution: string;
    txHash?: string;
    blockNumber?: bigint;
  }[] = [];

  async getCheckpoint(): Promise<{ lastProcessedBlock: bigint } | null> {
    return this.checkpoint === null ? null : { lastProcessedBlock: this.checkpoint };
  }

  async setCheckpoint(blockNumber: bigint): Promise<void> {
    // Mirrors the real repository: never moves backwards.
    if (this.checkpoint !== null && this.checkpoint >= blockNumber) return;
    this.checkpoint = blockNumber;
  }

  async log(entry: {
    orderId?: string;
    kind: string;
    discrepancy: string;
    resolution: string;
    txHash?: string;
    blockNumber?: bigint;
  }): Promise<void> {
    this.entries.push(entry);
  }
}
