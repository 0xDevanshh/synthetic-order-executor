import { z } from 'zod';
import 'dotenv/config';

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex address');

/**
 * Environment schema, parsed once at boot. The process refuses to start on a bad
 * config rather than failing later, mid-execution, against real funds.
 *
 * Note what is absent: EXECUTOR_PRIVATE_KEY. The API process reads chain state
 * and writes the database; it never signs. The signing key belongs to the worker
 * process alone, and leaving it out of this schema makes that structural rather
 * than a convention someone can forget.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),

  // Sepolia only. A literal, not a default, so a stray CHAIN_ID in the
  // environment cannot silently point this service at another network.
  CHAIN_ID: z.coerce.number().int().refine((v) => v === 11155111, {
    message: 'CHAIN_ID must be 11155111 (Ethereum Sepolia)',
  }),
  SEPOLIA_RPC_URL: z.string().url(),
  SEPOLIA_RPC_URL_FALLBACK: z.string().url().optional(),

  EXECUTOR_CONTRACT_ADDRESS: addressSchema,
  WETH_ADDRESS: addressSchema,
  USDC_ADDRESS: addressSchema,

  // Applied when deriving minAmountOut from the trigger price.
  EXECUTION_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
  DEADLINE_WINDOW_SEC: z.coerce.number().int().positive().default(120),
  DEFAULT_POOL_FEE: z.coerce.number().int().default(3000),

  // Price display for the UI. Same provider set the worker uses.
  PRICE_PROVIDER: z.enum(['chainlink', 'coingecko', 'static']).default('coingecko'),
  STATIC_PRICE: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: clear the memoised env so a case can supply its own. */
export function resetEnvCache(): void {
  cached = undefined;
}
