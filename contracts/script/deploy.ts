/**
 * Deploy SyntheticOrderExecutor.
 *
 *   pnpm --filter @soe/contracts deploy:sepolia
 *
 * Deliberately does NOT grant EXECUTOR_ROLE — that happens in configure.ts, so
 * the deployer key never holds execution rights even transiently.
 *
 * Writes contracts/deployments/<network>.json with address, block, constructor
 * args and commit hash, which is the input to configure.ts and to the backend's
 * EXECUTOR_CONTRACT_ADDRESS.
 */
import 'dotenv/config';

const SEPOLIA_CHAIN_ID = 11155111;

async function main(): Promise<void> {
  // TODO(impl):
  //  1. Resolve network; assert chainId is SEPOLIA_CHAIN_ID (or 31337 locally).
  //  2. Read constructor args from env:
  //       UNISWAP_SWAP_ROUTER_02, WETH_ADDRESS, admin (deployer or multisig),
  //       CONTRACT_MAX_SLIPPAGE_BPS, CONTRACT_MAX_DEADLINE_WINDOW_SEC
  //  3. Assert deployer balance covers deployment.
  //  4. Deploy via hre.viem.deployContract('SyntheticOrderExecutor', args).
  //  5. Wait for confirmations (>= 5 on Sepolia before verifying).
  //  6. Write deployments/<network>.json.
  //  7. Print the EXECUTOR_CONTRACT_ADDRESS line to paste into .env.
  throw new Error('TODO: implement deploy script');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
