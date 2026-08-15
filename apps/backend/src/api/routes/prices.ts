/**
 * GET /api/v1/prices/:pair -> latest tick, its source, age and suspect flag.
 *
 * Serves the most recent stored tick rather than hitting the oracle per
 * request, so the UI and the trigger evaluator agree on what "current price"
 * means.
 */

// TODO(impl)
export {};
