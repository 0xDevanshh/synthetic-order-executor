/**
 *   GET /health       -> liveness, no dependencies touched
 *   GET /health/deep  -> Neon, Redis and Sepolia RPC reachability + chain id
 *
 * The deep check asserts the RPC reports chain id 11155111, which catches a
 * misconfigured endpoint before it can cause a wrong-chain submission.
 */

// TODO(impl)
export {};
