/**
 * Thin wrapper over the DexAdapter for the preview endpoint, adding a short TTL
 * cache so UI polling does not hammer the Sepolia RPC.
 *
 * The executor does NOT use this cache — it always takes a fresh quote.
 */

// TODO(impl)
export {};
