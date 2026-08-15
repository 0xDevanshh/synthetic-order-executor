/**
 * Environment validation. Parsed once at boot with zod; the process refuses to
 * start on a bad config rather than failing later mid-execution.
 *
 * Note this schema deliberately does NOT include EXECUTOR_PRIVATE_KEY — the API
 * process has no business holding it.
 */

// TODO(impl): zod schema covering DATABASE_URL, REDIS_URL, SEPOLIA_RPC_URL,
//             CHAIN_ID (must equal 11155111), EXECUTOR_CONTRACT_ADDRESS,
//             UNISWAP_*, JWT_SECRET, SIWE_DOMAIN, API_PORT.
export {};
