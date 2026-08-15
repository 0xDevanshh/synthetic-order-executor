import { z } from 'zod';
import { getAddress, type Address } from 'viem';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex address');

/**
 * Chain configuration.
 *
 * EXECUTOR_PRIVATE_KEY is OPTIONAL here on purpose. The API process builds this
 * config to read chain state and must never hold a key; the worker supplies one.
 * A missing key yields a read-only client, and any attempt to send a transaction
 * fails loudly rather than silently doing nothing.
 */
const chainEnvSchema = z.object({
  CHAIN_ID: z.coerce.number().int().refine((v) => v === 11155111, {
    message: 'CHAIN_ID must be 11155111 (Ethereum Sepolia)',
  }),
  SEPOLIA_RPC_URL: z.string().url(),
  SEPOLIA_RPC_URL_FALLBACK: z.string().url().optional(),

  EXECUTOR_CONTRACT_ADDRESS: addressSchema,
  EXECUTOR_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 32-byte hex private key')
    .optional(),

  UNISWAP_SWAP_ROUTER_02: addressSchema.default('0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E'),
  UNISWAP_QUOTER_V2: addressSchema.default('0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3'),
  UNISWAP_V3_FACTORY: addressSchema.default('0x0227628f3F023bb0B980b67D528571c95c6DaC1c'),
  UNISWAP_POOL_FEE_TIERS: z.string().default('500,3000,10000'),

  WETH_ADDRESS: addressSchema.default('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'),
  USDC_ADDRESS: addressSchema.default('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'),

  /** Slippage applied to the FRESH quote when deriving minAmountOut. */
  EXECUTION_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(5_000).default(100),
  /** Seconds a submitted execution stays valid. */
  DEADLINE_WINDOW_SEC: z.coerce.number().int().positive().max(300).default(120),
  MAX_FEE_PER_GAS_GWEI: z.coerce.number().positive().default(100),
});

export interface ChainConfig {
  chainId: number;
  rpcUrls: string[];
  executorContract: Address;
  executorPrivateKey?: `0x${string}`;
  swapRouter: Address;
  quoterV2: Address;
  factory: Address;
  feeTiers: number[];
  weth: Address;
  usdc: Address;
  slippageBps: number;
  deadlineWindowSec: number;
  maxFeePerGasGwei: number;
}

export function loadChainConfig(env: NodeJS.ProcessEnv = process.env): ChainConfig {
  const parsed = chainEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid chain configuration:\n${issues}`);
  }

  const e = parsed.data;

  return {
    chainId: e.CHAIN_ID,
    rpcUrls: [e.SEPOLIA_RPC_URL, e.SEPOLIA_RPC_URL_FALLBACK].filter(
      (u): u is string => Boolean(u),
    ),
    executorContract: getAddress(e.EXECUTOR_CONTRACT_ADDRESS),
    executorPrivateKey: e.EXECUTOR_PRIVATE_KEY as `0x${string}` | undefined,
    swapRouter: getAddress(e.UNISWAP_SWAP_ROUTER_02),
    quoterV2: getAddress(e.UNISWAP_QUOTER_V2),
    factory: getAddress(e.UNISWAP_V3_FACTORY),
    feeTiers: e.UNISWAP_POOL_FEE_TIERS.split(',').map((f) => Number(f.trim())),
    weth: getAddress(e.WETH_ADDRESS),
    usdc: getAddress(e.USDC_ADDRESS),
    slippageBps: e.EXECUTION_SLIPPAGE_BPS,
    deadlineWindowSec: e.DEADLINE_WINDOW_SEC,
    maxFeePerGasGwei: e.MAX_FEE_PER_GAS_GWEI,
  };
}
