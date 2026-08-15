/**
 * Optional: deploy and seed a deterministic Uniswap V3 pool on Sepolia.
 *
 * Public Sepolia WETH/USDC pools are thin and inconsistently funded, which
 * makes an end-to-end demo depend on someone else's testnet liquidity. This
 * script deploys a MockERC20 pair, creates a pool, and provides liquidity we
 * control.
 *
 * The contract is unchanged either way — only the configured token addresses
 * differ. Fork tests still run against real pools for realism.
 */
import 'dotenv/config';

async function main(): Promise<void> {
  // TODO(impl):
  //  1. Check liquidity of the real WETH/USDC pool at each configured fee tier.
  //  2. If usable, exit early and print the pool address.
  //  3. Otherwise: deploy MockERC20 pair, factory.createPool, pool.initialize
  //     at the target price, mint a wide-range position via NonfungiblePositionManager.
  //  4. Print the token addresses to set in .env.
  throw new Error('TODO: implement pool seeding script');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
