/**
 * Serialized nonce allocation for the executor EOA, behind a Redis mutex.
 *
 * Nonces are allocated strictly in order. A gap or a stuck transaction blocks
 * the queue by design: with one signer, proceeding past a stuck nonce cannot
 * work, and pretending otherwise produces a pile of transactions that can never
 * mine.
 *
 * Resyncs from getTransactionCount('pending') on startup and after any
 * nonce-related RPC error.
 */

// TODO(impl)
export {};
