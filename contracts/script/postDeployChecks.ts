/**
 * Read-only post-deployment inspection.
 *
 *   npx hardhat run script/postDeployChecks.ts --network sepolia
 *
 * Every call here is an `eth_call`. Nothing is broadcast, no gas is spent, and
 * no value moves. Safe to run against a live deployment at any time, including
 * as a monitoring probe.
 */
import hre from 'hardhat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUnits, getAddress, zeroAddress } from 'viem';
import 'dotenv/config';

import { SEPOLIA_CHAIN_ID } from './preflight';
import type { DeploymentRecord } from './deploy';

async function main(): Promise<void> {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  const path = join(__dirname, '..', 'deployments', `${hre.network.name}.json`);
  const deployment = JSON.parse(readFileSync(path, 'utf8')) as DeploymentRecord;
  const soe = await hre.viem.getContractAt('SyntheticOrderExecutor', deployment.address);

  const weth = getAddress(process.env.WETH_ADDRESS!);
  const usdc = getAddress(process.env.USDC_ADDRESS!);

  console.log('\n=== SyntheticOrderExecutor — read-only state ===\n');

  // --- Identity --------------------------------------------------------------
  console.log('Deployment');
  console.log(`  contract address : ${deployment.address}`);
  console.log(`  deployment tx    : ${deployment.deploymentTxHash}`);
  console.log(`  chain id         : ${chainId}${chainId === SEPOLIA_CHAIN_ID ? ' (Sepolia)' : ' (UNEXPECTED)'}`);
  console.log(`  block            : ${deployment.blockNumber}`);

  const code = await publicClient.getCode({ address: deployment.address });
  console.log(`  bytecode present : ${code && code !== '0x' ? `yes (${(code.length - 2) / 2} bytes)` : 'NO — nothing deployed here'}`);

  // --- Wiring ----------------------------------------------------------------
  console.log('\nWiring');
  console.log(`  swapRouter       : ${await soe.read.swapRouter()}`);
  console.log(`  weth             : ${await soe.read.weth()}`);

  // --- Access control --------------------------------------------------------
  const executor = await soe.read.executor();
  const executorRole = await soe.read.EXECUTOR_ROLE();
  const adminRole = await soe.read.DEFAULT_ADMIN_ROLE();

  console.log('\nAccess control');
  console.log(`  executor         : ${executor}${executor === zeroAddress ? '  <- execution disabled' : ''}`);
  console.log(`  executor role ok : ${await soe.read.hasRole([executorRole, executor])}`);
  console.log(`  admin            : ${deployment.admin}`);
  console.log(`  admin role ok    : ${await soe.read.hasRole([adminRole, getAddress(deployment.admin)])}`);
  console.log(`  deployer has exec: ${await soe.read.hasRole([executorRole, getAddress(deployment.deployer)])}  <- must be false`);

  // --- Operational state -----------------------------------------------------
  console.log('\nOperational state');
  console.log(`  paused           : ${await soe.read.paused()}`);

  // --- Token configuration ---------------------------------------------------
  console.log('\nToken configuration');
  for (const [symbol, address, decimals] of [
    ['WETH', weth, 18],
    ['USDC', usdc, 6],
  ] as const) {
    const allowed = await soe.read.allowedToken([address]);
    const cap = (await soe.read.maxTradeAmount([address])) as bigint;
    const accounted = (await soe.read.totalAccounted([address])) as bigint;
    const unaccounted = (await soe.read.unaccountedBalance([address])) as bigint;
    console.log(`  ${symbol.padEnd(5)} ${address}`);
    console.log(`        allowed        : ${allowed}`);
    console.log(`        max trade      : ${formatUnits(cap, decimals)} ${symbol}`);
    console.log(`        totalAccounted : ${formatUnits(accounted, decimals)} ${symbol}`);
    console.log(`        unaccounted    : ${formatUnits(unaccounted, decimals)} ${symbol}`);
  }

  console.log('\nNo transactions were broadcast. All calls were read-only.\n');
}

main().catch((error: unknown) => {
  console.error(`\nREAD-ONLY CHECKS FAILED: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
