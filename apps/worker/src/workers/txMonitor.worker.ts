/**
 * tx-monitor — NOT YET IMPLEMENTED.
 *
 * Resolves a submitted transaction to a terminal state. A dropped transaction
 * is NEVER marked FAILED without first reading `isExecuted(executionId)`
 * on-chain — a transaction can be slow rather than dead, and assuming otherwise
 * is how you double-execute.
 */
export {};
