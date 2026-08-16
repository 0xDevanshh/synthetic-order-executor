/**
 * Domain logic and persistence shared by the API and the worker.
 *
 * This package exists so the order state machine and — critically — the atomic
 * claim that moves an order out of PENDING live in exactly one place. Two
 * copies of that logic in two processes is how duplicate execution gets
 * reintroduced after being designed out.
 */
export * from './domain/orderStatus.js';
export * from './domain/executionId.js';
export * from './domain/trigger.js';
export * from './repositories/order.repository.js';
export * from './repositories/reconciliation.repository.js';
