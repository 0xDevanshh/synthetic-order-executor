/**
 * SIWE (Sign-In With Ethereum) authentication.
 *
 *   POST /api/v1/auth/nonce   -> single-use nonce
 *   POST /api/v1/auth/verify  -> verify SIWE message -> short-lived JWT
 *
 * The JWT subject is the checksummed address; every order route scopes its
 * queries to it, so a user can only ever see or mutate their own orders.
 */

// TODO(impl)
export {};
