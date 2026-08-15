/**
 * Deploy mock Uniswap/token dependencies to a local Hardhat node.
 *
 *   npx hardhat run script/localMocks.ts --network localhost
 *
 * Exists so the real deployment pipeline (deploy -> configure ->
 * postDeployChecks) can be exercised end to end without touching Sepolia.
 * Emits shell-ready export lines for the addresses it creates.
 */
import hre from 'hardhat';
import 'dotenv/config';

async function main(): Promise<void> {
  const router = await hre.viem.deployContract('MockSwapRouter', []);
  const weth = await hre.viem.deployContract('MockWETH9', []);
  const usdc = await hre.viem.deployContract('MockERC20', ['USD Coin', 'USDC', 6]);

  console.log(`export UNISWAP_SWAP_ROUTER_02=${router.address}`);
  console.log(`export WETH_ADDRESS=${weth.address}`);
  console.log(`export USDC_ADDRESS=${usdc.address}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
