/**
 * GET /api/v1/system/config
 *
 * Public, non-secret runtime config for the frontend: chain id, executor
 * contract address, allowlisted tokens with decimals, per-token max trade size,
 * and the contract's maxSlippageBps. Read from the chain, not from env, so the
 * UI can never present limits that disagree with what the contract enforces.
 */

// TODO(impl)
export {};
