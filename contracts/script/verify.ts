/**
 * Verify the deployed contract on Etherscan (Sepolia).
 *
 *   pnpm --filter @soe/contracts verify:sepolia
 */
import 'dotenv/config';

async function main(): Promise<void> {
  // TODO(impl): read deployments/<network>.json, call hre.run('verify:verify',
  //             { address, constructorArguments }), tolerate "Already Verified".
  throw new Error('TODO: implement verify script');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
