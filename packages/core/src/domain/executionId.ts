import { keccak256, toHex } from 'viem';
import type { Hex } from 'viem';

/**
 * Derive the on-chain `executionId` for an order.
 *
 * Deterministic on the order id, which matters: a retry recomputes the same
 * value, so the contract's `executedIds` guard rejects the duplicate. If this
 * were random per attempt, every retry would look like a fresh execution to the
 * contract and the replay protection would be worthless.
 *
 * Namespaced so an id from this system can never collide with a bytes32 minted
 * for another purpose against the same contract.
 */
export function deriveExecutionId(orderId: string): Hex {
  return keccak256(toHex(`soe:order:v1:${orderId}`));
}
