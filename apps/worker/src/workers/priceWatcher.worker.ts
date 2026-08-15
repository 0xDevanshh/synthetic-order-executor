/**
 * price-watcher (repeatable, 10s)
 *
 * Reads the primary Chainlink feed and the cross-check source, applies the
 * staleness / round-completeness / divergence guards, persists a PriceTick, and
 * publishes to Redis so the trigger evaluator can react without waiting for its
 * own poll.
 *
 * Suspect ticks are still persisted — the audit trail of a wedged oracle is
 * exactly what you want when explaining why an order did not fire.
 */

// TODO(impl)
export {};
