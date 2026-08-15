/**
 * Deploy SyntheticOrderExecutor to Ethereum Sepolia.
 *
 *   npx hardhat run script/deploy.ts --network sepolia
 *
 * Refuses to broadcast unless every pre-flight check passes (see preflight.ts):
 * chain id is exactly 11155111, the RPC is live, the deployer is funded, and
 * both constructor addresses hold bytecode on this chain.
 *
 * Deliberately deploys with executor = address(0). EXECUTOR_ROLE is granted by
 * configure.ts in a separate, independently auditable transaction, so the
 * deployer key never holds execution rights even transiently.
 *
 * Writes deployments/sepolia.json, which is the input to configure.ts,
 * verify.ts, postDeployChecks.ts and the backend's EXECUTOR_CONTRACT_ADDRESS.
 */
import hre from 'hardhat';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { formatEther, getAddress, zeroAddress, type Address, type Hex } from 'viem';
import 'dotenv/config';

import { preflight, LOCAL_CHAIN_ID, SEPOLIA_CHAIN_ID } from './preflight';

export interface DeploymentRecord {
  contractName: string;
  address: Address;
  deploymentTxHash: Hex;
  blockNumber: string;
  network: string;
  chainId: number;
  deployer: Address;
  admin: Address;
  executor: Address;
  constructorArgs: {
    swapRouter: Address;
    weth: Address;
    admin: Address;
    executor: Address;
  };
  compiler: { version: string; optimizer: boolean; runs: number; viaIR: boolean };
  gitCommit: string;
  deployedAt: string;
  bytecodeVerified: boolean;
  etherscanVerified: boolean;
}

const CONTRACT_SOURCE = 'src/SyntheticOrderExecutor.sol';
const CONTRACT_NAME = 'SyntheticOrderExecutor';

/**
 * Compare on-chain code against the local artifact, ignoring immutable slots.
 *
 * A naive string comparison always fails here, and the reason is worth stating:
 * the compiler inlines immutables (`swapRouter`, `weth`) directly into the
 * deployed code, but the artifact stores those positions as zeroes. The two
 * therefore differ at exactly the immutable offsets even for a perfectly
 * correct deployment.
 *
 * Solc records those offsets as `immutableReferences`, so the honest comparison
 * masks them in both inputs and compares everything else. That still proves the
 * deployed logic is byte-identical to what was compiled locally — the property
 * actually worth verifying — while the constructor arguments are confirmed
 * separately by reading `swapRouter()` and `weth()` back in postDeployChecks.
 */
async function verifyBytecode(
  onChainCode: string | undefined,
  artifactCode: string,
): Promise<boolean> {
  if (!onChainCode || onChainCode === '0x') return false;

  const buildInfo = await hre.artifacts.getBuildInfo(`${CONTRACT_SOURCE}:${CONTRACT_NAME}`);
  const immutableReferences =
    buildInfo?.output?.contracts?.[CONTRACT_SOURCE]?.[CONTRACT_NAME]?.evm?.deployedBytecode
      ?.immutableReferences ?? {};

  const mask = (hex: string): string => {
    const chars = hex.toLowerCase().replace(/^0x/, '').split('');
    for (const refs of Object.values(immutableReferences)) {
      for (const { start, length } of refs as Array<{ start: number; length: number }>) {
        for (let i = start * 2; i < (start + length) * 2 && i < chars.length; i += 1) {
          chars[i] = '0';
        }
      }
    }
    return chars.join('');
  };

  const maskedOnChain = mask(onChainCode);
  const maskedArtifact = mask(artifactCode);

  if (maskedOnChain.length !== maskedArtifact.length) return false;
  return maskedOnChain === maskedArtifact;
}

function gitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  console.log('\n=== SyntheticOrderExecutor deployment ===\n');

  // --- Pre-flight (checks 4, 5, 6, 7) ---------------------------------------
  const pre = await preflight();

  // Belt and braces: assert once more immediately before broadcasting, in case
  // anything above is ever refactored into being advisory.
  const isLocalDryRun = pre.chainId === LOCAL_CHAIN_ID && process.env.ALLOW_LOCAL_DEPLOY === '1';
  if (pre.chainId !== SEPOLIA_CHAIN_ID && !isLocalDryRun) {
    throw new Error(`Refusing to deploy: chain id ${pre.chainId} is not Sepolia.`);
  }
  if (isLocalDryRun) {
    console.log('  [note] LOCAL DRY RUN — deploying to the Hardhat chain, not Sepolia.\n');
  }

  const constructorArgs = [pre.swapRouter, pre.weth, pre.admin, zeroAddress] as const;

  console.log('Constructor arguments');
  console.log(`  swapRouter : ${constructorArgs[0]}`);
  console.log(`  weth       : ${constructorArgs[1]}`);
  console.log(`  admin      : ${constructorArgs[2]}`);
  console.log(`  executor   : ${constructorArgs[3]} (granted separately by configure.ts)\n`);

  // --- Deploy ----------------------------------------------------------------
  const publicClient = await hre.viem.getPublicClient();
  const balanceBefore = await publicClient.getBalance({ address: pre.deployer });

  // Deployed through the wallet client rather than hre.viem.deployContract so
  // the deployment transaction hash is captured directly. Recording the hash is
  // a hard requirement of the deployment record, and recovering it after the
  // fact means scanning blocks.
  console.log('Broadcasting deployment transaction...');
  const [walletClient] = await hre.viem.getWalletClients();
  if (!walletClient) throw new Error('No signer available.');

  const artifact = await hre.artifacts.readArtifact('SyntheticOrderExecutor');

  const deploymentTxHash: Hex = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    args: [...constructorArgs],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTxHash });
  if (receipt.status !== 'success') {
    throw new Error(`Deployment transaction reverted: ${deploymentTxHash}`);
  }
  if (!receipt.contractAddress) {
    throw new Error('Receipt contained no contract address.');
  }

  const soe = { address: getAddress(receipt.contractAddress) };

  console.log(`  address : ${soe.address}`);
  console.log(`  tx      : ${deploymentTxHash}`);
  console.log(`  block   : ${receipt.blockNumber}`);
  console.log(`  gas     : ${receipt.gasUsed}`);

  const balanceAfter = await publicClient.getBalance({ address: pre.deployer });
  console.log(`  cost    : ${formatEther(balanceBefore - balanceAfter)} ETH\n`);

  // --- Verify deployed bytecode matches the local build ----------------------
  const onChainCode = await publicClient.getCode({ address: soe.address });
  const bytecodeVerified = await verifyBytecode(onChainCode, artifact.deployedBytecode);

  if (bytecodeVerified) {
    console.log('  [ok]   deployed bytecode matches the local build\n');
  } else {
    console.warn(
      '  [WARN] deployed bytecode differs from the local artifact.\n' +
        '         Investigate before use: recompile at the deployed commit and re-compare.\n',
    );
  }

  // --- Record ----------------------------------------------------------------
  // A local dry run must never overwrite the real Sepolia record — that file is
  // the source of truth for configure/verify/postDeployChecks and for the
  // backend's contract address.
  const networkName = isLocalDryRun ? 'localhost' : 'sepolia';

  const record: DeploymentRecord = {
    contractName: CONTRACT_NAME,
    address: soe.address,
    deploymentTxHash,
    blockNumber: receipt.blockNumber.toString(),
    network: networkName,
    chainId: pre.chainId,
    deployer: pre.deployer,
    admin: pre.admin,
    executor: zeroAddress,
    constructorArgs: {
      swapRouter: constructorArgs[0],
      weth: constructorArgs[1],
      admin: constructorArgs[2],
      executor: constructorArgs[3],
    },
    compiler: { version: '0.8.24', optimizer: true, runs: 200, viaIR: true },
    gitCommit: gitCommit(),
    deployedAt: new Date().toISOString(),
    bytecodeVerified,
    etherscanVerified: false,
  };

  const dir = join(__dirname, '..', 'deployments');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${networkName}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`Deployment record written to ${path}\n`);
  console.log('Add to your .env files:\n');
  console.log(`  EXECUTOR_CONTRACT_ADDRESS="${soe.address}"`);
  console.log(`  NEXT_PUBLIC_EXECUTOR_CONTRACT="${soe.address}"\n`);
  console.log('Next steps:');
  console.log('  1. npx hardhat run script/configure.ts --network sepolia');
  console.log('  2. npx hardhat run script/verify.ts --network sepolia');
  console.log('  3. npx hardhat run script/postDeployChecks.ts --network sepolia\n');
}

main().catch((error: unknown) => {
  console.error(`\nDEPLOYMENT FAILED: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
