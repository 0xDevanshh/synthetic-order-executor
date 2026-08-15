/**
 * Read-only viem client for Ethereum Sepolia (chain id 11155111).
 *
 * Used by both the API (quote previews) and the worker (pre-flight reads,
 * receipts, log scanning). Holds no keys.
 */

// TODO(impl):
//   - createPublicClient({ chain: sepolia, transport: fallback([
//       http(SEPOLIA_RPC_URL), http(SEPOLIA_RPC_URL_FALLBACK)]) })
//   - assert client.getChainId() === 11155111 at startup and refuse to boot
//     otherwise, so a misconfigured RPC can never silently target the wrong chain
//   - block-number sanity check across providers to catch a lagging node
export {};
