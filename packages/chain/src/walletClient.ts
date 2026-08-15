/**
 * Signing client for the executor hot wallet.
 *
 * IMPORTANT: only the worker process ever imports this. The API process must
 * never hold EXECUTOR_PRIVATE_KEY — separating them is what keeps a
 * public-facing HTTP surface away from the signing key.
 *
 * The key holds gas ETH only. Because the contract requires a user EIP-712
 * signature and credits output back to the order owner, compromising this key
 * yields griefing (wasted gas, badly timed but user-authorized executions),
 * not theft.
 */

// TODO(impl):
//   - privateKeyToAccount(EXECUTOR_PRIVATE_KEY), createWalletClient(sepolia)
//   - never log the key or the account object
//   - in production, swap for a KMS/Vault signer behind the same interface
export {};
