/**
 * Post-deployment configuration, run once against a fresh deployment.
 *
 *   pnpm --filter @soe/contracts configure:sepolia
 *
 * Every write is followed by a read-back assertion — configuration is verified
 * from chain state, never assumed from the fact that a tx succeeded.
 */
import 'dotenv/config';

async function main(): Promise<void> {
  // TODO(impl):
  //  1. Load EXECUTOR_CONTRACT_ADDRESS from deployments/<network>.json.
  //  2. setAllowedToken(WETH, true); setAllowedToken(USDC, true).
  //  3. setMaxTradeSize(WETH, MAX_TRADE_SIZE_WETH).
  //     setMaxTradeSize(USDC, MAX_TRADE_SIZE_USDC).
  //  4. grantRole(EXECUTOR_ROLE, address(EXECUTOR_PRIVATE_KEY)).
  //  5. grantRole(PAUSER_ROLE, ops address).
  //  6. Read back and assert EVERY value, including:
  //       - deployer does NOT hold EXECUTOR_ROLE
  //       - admin role holder is the intended address
  //  7. Print a configuration summary table.
  throw new Error('TODO: implement configure script');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
