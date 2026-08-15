/**
 * Create-order form.
 *
 * Flow: POST /orders/prepare -> user signs the returned EIP-712 payload with
 * wagmi's signTypedData -> POST /orders with { intent, trigger, signature }.
 *
 * The signature is the whole trust story, so the UI must show the user exactly
 * what they are authorizing: amount in, minimum out, expiry, and the fact that
 * the backend can only tighten the minimum, never loosen it.
 *
 * TODO(impl)
 */
export function CreateOrderForm() {
  return null;
}
