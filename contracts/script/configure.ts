/**
 * Post-deployment configuration. Run once against a fresh deployment.
 *
 *   npx hardhat run script/configure.ts --network sepolia
 *
 * Every write is followed by a read-back assertion. Configuration is confirmed
 * from chain state, never inferred from the fact that a transaction succeeded —
 * a transaction can succeed and still have written something other than what
 * you intended.
 */
import hre from 'hardhat';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { formatUnits, getAddress, isAddress, zeroAddress, type Address } from 'viem';
import 'dotenv/config';

import { LOCAL_CHAIN_ID, SEPOLIA_CHAIN_ID } from './preflight';
import type { DeploymentRecord } from './deploy';

function loadDeployment(): DeploymentRecord {
  const path = join(__dirname, '..', 'deployments', `${hre.network.name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as DeploymentRecord;
}

/**
 * Derive the executor address from EXECUTOR_PRIVATE_KEY without ever printing
 * or persisting the key itself. Only the public address is logged.
 */
function resolveExecutorAddress(): Address {
  const explicit = process.env.EXECUTOR_ADDRESS?.trim();
  if (explicit) {
    if (!isAddress(explicit)) throw new Error(`EXECUTOR_ADDRESS is not a valid address`);
    return getAddress(explicit);
  }

  const key = process.env.EXECUTOR_PRIVATE_KEY?.trim();
  if (!key) throw new Error('Set EXECUTOR_ADDRESS or EXECUTOR_PRIVATE_KEY');
  if (key === `0x${'0'.repeat(64)}`) {
    throw new Error('EXECUTOR_PRIVATE_KEY is still the .env.example placeholder');
  }
  return getAddress(privateKeyToAccount(key as `0x${string}`).address);
}

async function main(): Promise<void> {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const isLocalDryRun = chainId === LOCAL_CHAIN_ID && process.env.ALLOW_LOCAL_DEPLOY === '1';
  if (chainId !== SEPOLIA_CHAIN_ID && !isLocalDryRun) {
    throw new Error(`Refusing to configure: chain id ${chainId} is not Sepolia.`);
  }

  const deployment = loadDeployment();
  const [adminClient] = await hre.viem.getWalletClients();
  if (!adminClient) throw new Error('No signer available.');

  const soe = await hre.viem.getContractAt('SyntheticOrderExecutor', deployment.address);

  const weth = getAddress(process.env.WETH_ADDRESS!);
  const usdc = getAddress(process.env.USDC_ADDRESS!);
  const maxWeth = BigInt(process.env.MAX_TRADE_SIZE_WETH ?? '1000000000000000000');
  const maxUsdc = BigInt(process.env.MAX_TRADE_SIZE_USDC ?? '5000000000');
  const executorAddress = resolveExecutorAddress();

  console.log('\n=== Configuring SyntheticOrderExecutor ===\n');
  console.log(`  contract : ${deployment.address}`);
  console.log(`  executor : ${executorAddress}\n`);

  /**
   * Submit a write and BLOCK until it is mined and confirmed successful.
   *
   * hardhat-viem's `write` resolves as soon as the transaction is submitted, not
   * when it is mined. On a local auto-mining node that distinction is invisible,
   * because the next read already sees the new state. On a real network the
   * read-backs below would run against a block where nothing had landed yet and
   * report a false failure — or worse, a false success on a transaction that
   * later reverted. So every write is awaited to a receipt here, and a reverted
   * receipt aborts immediately rather than being reported as a mismatch.
   */
  const send = async (label: string, hash: `0x${string}`): Promise<void> => {
    process.stdout.write(`  ${label} ... `);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') {
      throw new Error(`${label} reverted (tx ${hash})`);
    }
    console.log(`mined in block ${receipt.blockNumber} (${hash})`);
  };

  // --- 1. Allowlist the traded tokens with their caps ------------------------
  // Each write is skipped when the chain already holds the target value, so the
  // script is safely re-runnable after a partial failure without burning gas on
  // no-op transactions.
  console.log('Allowlisting tokens...');

  for (const [symbol, token, cap] of [
    ['WETH', weth, maxWeth],
    ['USDC', usdc, maxUsdc],
  ] as const) {
    const alreadyAllowed = await soe.read.allowedToken([token]);
    const currentCap = (await soe.read.maxTradeAmount([token])) as bigint;

    if (alreadyAllowed && currentCap === cap) {
      console.log(`  setTokenAllowed(${symbol}) ... already configured, skipping`);
      continue;
    }
    await send(
      `setTokenAllowed(${symbol})`,
      await soe.write.setTokenAllowed([token, cap], { account: adminClient.account }),
    );
  }

  // --- 2. Appoint the executor ----------------------------------------------
  console.log('\nAppointing executor...');
  const currentExecutor = (await soe.read.executor()) as Address;

  if (getAddress(currentExecutor) === executorAddress) {
    console.log('  setExecutor ... already appointed, skipping');
  } else {
    await send(
      'setExecutor',
      await soe.write.setExecutor([executorAddress], { account: adminClient.account }),
    );
  }

  // --- 3. Read back and assert EVERY value ----------------------------------
  console.log('\nVerifying configuration from chain state...\n');

  const checks: Array<[string, unknown, unknown]> = [];

  checks.push(['WETH allowlisted', await soe.read.allowedToken([weth]), true]);
  checks.push(['USDC allowlisted', await soe.read.allowedToken([usdc]), true]);
  checks.push(['WETH max trade', await soe.read.maxTradeAmount([weth]), maxWeth]);
  checks.push(['USDC max trade', await soe.read.maxTradeAmount([usdc]), maxUsdc]);
  checks.push(['executor address', await soe.read.executor(), executorAddress]);

  const executorRole = await soe.read.EXECUTOR_ROLE();
  const adminRole = await soe.read.DEFAULT_ADMIN_ROLE();
  const deployerAddress = getAddress(adminClient.account.address);

  checks.push([
    'executor holds EXECUTOR_ROLE',
    await soe.read.hasRole([executorRole, executorAddress]),
    true,
  ]);

  // The critical negative assertion: the deploying key must NOT be able to
  // execute trades. If this ever reads true, the deployment is compromised by
  // construction and must be redeployed rather than patched.
  checks.push([
    'deployer does NOT hold EXECUTOR_ROLE',
    await soe.read.hasRole([executorRole, deployerAddress]),
    false,
  ]);
  checks.push([
    'admin holds DEFAULT_ADMIN_ROLE',
    await soe.read.hasRole([adminRole, getAddress(deployment.admin)]),
    true,
  ]);
  checks.push(['contract not paused', await soe.read.paused(), false]);

  let failed = 0;
  for (const [label, actual, expected] of checks) {
    const pass = String(actual).toLowerCase() === String(expected).toLowerCase();
    if (!pass) failed += 1;
    console.log(`  ${pass ? '[ok]  ' : '[FAIL]'} ${label}: ${actual}${pass ? '' : ` (expected ${expected})`}`);
  }

  if (failed > 0) {
    throw new Error(`${failed} configuration assertion(s) failed. Do NOT use this deployment.`);
  }

  console.log(`\n  WETH cap: ${formatUnits(maxWeth, 18)} WETH`);
  console.log(`  USDC cap: ${formatUnits(maxUsdc, 6)} USDC\n`);

  // Persist the executor into the deployment record now that it is confirmed.
  const path = join(__dirname, '..', 'deployments', `${hre.network.name}.json`);
  const updated: DeploymentRecord = { ...deployment, executor: executorAddress };
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);

  console.log('All configuration assertions passed.\n');
  if (updated.executor === zeroAddress) {
    console.warn('  [WARN] executor is still the zero address.\n');
  }
}

main().catch((error: unknown) => {
  console.error(`\nCONFIGURATION FAILED: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
