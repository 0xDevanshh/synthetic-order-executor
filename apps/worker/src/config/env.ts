import { z } from 'zod';
import 'dotenv/config';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex address');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  /** Which PriceProvider drives the engine. See price/*.provider.ts. */
  PRICE_PROVIDER: z.enum(['chainlink', 'coingecko', 'static']).default('coingecko'),
  /** Optional second source for the divergence guard. */
  PRICE_CROSSCHECK_PROVIDER: z.enum(['chainlink', 'coingecko', 'none']).default('none'),
  /** Only read when PRICE_PROVIDER=static. */
  STATIC_PRICE: z.string().optional(),

  SEPOLIA_RPC_URL: z.string().url().optional(),
  CHAINLINK_ETH_USD_FEED: addressSchema.default('0x694AA1769357215DE4FAC081bf1f309aDC325306'),

  PRICE_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  MAX_PRICE_STALENESS_SEC: z.coerce.number().int().positive().default(3_600),
  MAX_PRICE_DIVERGENCE_BPS: z.coerce.number().int().positive().default(200),
  TRIGGER_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(100),

  /** Gap between monitor re-checks of a still-pending transaction. */
  TX_RECHECK_DELAY_MS: z.coerce.number().int().min(1_000).default(15_000),
  /** How long a tx may be invisible before we consult the contract about it. */
  PENDING_GRACE_MS: z.coerce.number().int().min(10_000).default(180_000),
  /** An EXECUTING order older than this is swept. */
  TX_STUCK_AFTER_MS: z.coerce.number().int().min(30_000).default(300_000),
  TX_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),

  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  /** Blocks re-scanned below the checkpoint each pass, to absorb reorgs. */
  REORG_BUFFER_BLOCKS: z.coerce.number().int().min(0).default(12),
  /** Cap on the block span scanned per pass, to bound RPC cost. */
  RECONCILE_MAX_BLOCK_RANGE: z.coerce.number().int().positive().default(5_000),
  RECONCILE_AUDIT_LIMIT: z.coerce.number().int().positive().max(1_000).default(100),
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
    throw new Error(`Invalid worker environment:\n${issues}`);
  }

  const env = parsed.data;

  // A synthetic order engine trading against a hardcoded price is the single
  // most dangerous misconfiguration in this system, so it is refused outright
  // rather than warned about.
  if (env.NODE_ENV === 'production' && env.PRICE_PROVIDER === 'static') {
    throw new Error('PRICE_PROVIDER=static is not permitted when NODE_ENV=production');
  }

  if (env.PRICE_PROVIDER === 'chainlink' && !env.SEPOLIA_RPC_URL) {
    throw new Error('PRICE_PROVIDER=chainlink requires SEPOLIA_RPC_URL');
  }

  cached = env;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
