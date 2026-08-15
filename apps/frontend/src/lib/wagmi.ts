/**
 * wagmi config, pinned to Ethereum Sepolia (11155111).
 *
 * The UI must refuse to sign while the wallet is on any other chain — an
 * order signed under a different chainId will fail signature verification
 * on-chain, since the EIP-712 domain binds it.
 *
 * TODO(impl)
 */
export {};
