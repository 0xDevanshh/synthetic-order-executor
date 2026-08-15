/**
 * Verify the deployed contract on Sepolia Etherscan.
 *
 *   npx hardhat run script/verify.ts --network sepolia
 *
 * Requires ETHERSCAN_API_KEY. Constructor arguments are read from the
 * deployment record rather than retyped, since a mismatch there is the usual
 * cause of a failed verification.
 */
import hre from 'hardhat';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';

import type { DeploymentRecord } from './deploy';

async function main(): Promise<void> {
  if (!process.env.ETHERSCAN_API_KEY) {
    throw new Error('ETHERSCAN_API_KEY is not set — cannot verify.');
  }

  const path = join(__dirname, '..', 'deployments', `${hre.network.name}.json`);
  const deployment = JSON.parse(readFileSync(path, 'utf8')) as DeploymentRecord;

  console.log(`\nVerifying ${deployment.address} on Sepolia Etherscan...\n`);

  try {
    await hre.run('verify:verify', {
      address: deployment.address,
      constructorArguments: [
        deployment.constructorArgs.swapRouter,
        deployment.constructorArgs.weth,
        deployment.constructorArgs.admin,
        deployment.constructorArgs.executor,
      ],
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Re-verifying an already-verified contract is a success, not a failure.
    if (!/already verified/i.test(message)) throw error;
    console.log('Contract was already verified.');
  }

  writeFileSync(
    path,
    `${JSON.stringify({ ...deployment, etherscanVerified: true }, null, 2)}\n`,
  );

  console.log(`\nVerified: https://sepolia.etherscan.io/address/${deployment.address}#code\n`);
}

main().catch((error: unknown) => {
  console.error(`\nVERIFICATION FAILED: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
