/**
 * All order persistence. The only place raw Prisma order queries live.
 *
 * The critical method is the atomic claim, which must stay a single statement:
 *
 *   UPDATE orders SET status = 'EXECUTING', version = version + 1
 *   WHERE id = $1 AND status = 'TRIGGERED' AND version = $2
 *   RETURNING *;
 *
 * Zero rows returned means another worker won the race — no distributed lock is
 * needed for correctness, and none should be added.
 */

// TODO(impl): findTriggerable, claimForExecution, transitionStatus (validated
//             through orderStateMachine), findByHash, listByUser.
export {};
