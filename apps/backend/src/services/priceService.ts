/**
 * PriceService implementation: primary Chainlink reading plus the cross-source
 * divergence guard, producing the validated PriceTick the rest of the system
 * consumes.
 *
 * Shared with the worker's price-watcher — the API reads stored ticks, the
 * worker writes them, and both agree on what makes a tick suspect.
 */

// TODO(impl)
export {};
