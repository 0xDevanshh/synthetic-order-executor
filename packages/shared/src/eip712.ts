import type { Address, Hex } from 'viem';
import type { SignedOrderIntent } from './types/order.js';

/**
 * EIP-712 definitions for the order intent.
 *
 * These MUST stay byte-identical to `SyntheticOrderExecutor.ORDER_TYPEHASH` and
 * the contract's EIP712 constructor arguments. The domain binds chainId and the
 * verifying contract address, so a signature produced for Sepolia cannot be
 * replayed on another chain or against a redeployed instance.
 *
 * Drift between this file and the contract is caught by the golden-vector test:
 * the backend suite hashes fixtures here and asserts equality with the value
 * returned by `SyntheticOrderExecutor.hashOrder`.
 */
export const EIP712_DOMAIN_NAME = 'SyntheticOrderExecutor' as const;
export const EIP712_DOMAIN_VERSION = '1' as const;

export const ORDER_TYPES = {
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export function buildOrderDomain(chainId: number, verifyingContract: Address) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

/** Compute the EIP-712 digest. Must equal the contract's `hashOrder`. */
export function hashOrder(
  _order: SignedOrderIntent,
  _chainId: number,
  _verifyingContract: Address,
): Hex {
  // TODO(impl): viem hashTypedData({ domain, types: ORDER_TYPES,
  //             primaryType: 'Order', message: order }).
  throw new Error('TODO: implement hashOrder');
}

/** Recover the signer and check it equals `order.owner`. Supports EIP-1271. */
export function verifyOrderSignature(
  _order: SignedOrderIntent,
  _signature: Hex,
  _chainId: number,
  _verifyingContract: Address,
): Promise<boolean> {
  // TODO(impl): viem verifyTypedData (falls back to EIP-1271 for contract wallets).
  throw new Error('TODO: implement verifyOrderSignature');
}
