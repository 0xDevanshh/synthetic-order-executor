/**
 * Pre-deployment verification. Read-only: touches no state, spends no gas.
 *
 *   npx hardhat run script/preflight.ts --network sepolia
 *
 * Runs every check that must pass before `deploy.ts` is allowed to broadcast.
 * `deploy.ts` re-runs these itself, so this script exists to let you inspect the
 * results without committing to anything.
 */
import hre from 'hardhat';
import { formatEther, getAddress, isAddress, zeroAddress, type Address } from 'viem';
import 'dotenv/config';

export const SEPOLIA_CHAIN_ID = 11155111;

/** Hardhat's in-process chain, used only for local dry runs. */
export const LOCAL_CHAIN_ID = 31337;

/**
 * Chain ids we refuse to touch under any circumstances. Ethereum mainnet leads
 * the list; the others are included because a mistyped RPC URL is exactly how a
 * testnet deploy becomes a mainnet one.
 */
const FORBIDDEN_CHAIN_IDS: Record<number, string> = {
  1: 'Ethereum Mainnet',
  10: 'OP Mainnet',
  56: 'BNB Smart Chain',
  137: 'Polygon Mainnet',
  8453: 'Base Mainnet',
  42161: 'Arbitrum One',
  43114: 'Avalanche C-Chain',
};

/** Minimum deployer balance. Deployment costs well under this on Sepolia. */
const MIN_DEPLOYER_BALANCE_WEI = 10_000_000_000_000_000n; // 0.01 ETH

export interface PreflightResult {
  chainId: number;
  deployer: Address;
  deployerBalance: bigint;
  swapRouter: Address;
  weth: Address;
  admin: Address;
  executor: Address;
  executorIsZero: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function requireAddressEnv(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value)) {
    throw new Error(`${name} is not a valid EVM address: ${value}`);
  }
  return getAddress(value);
}

/** Placeholder values from .env.example that must never reach a real network. */
function rejectPlaceholders(): void {
  const zeroKey = `0x${'0'.repeat(64)}`;
  if (process.env.DEPLOYER_PRIVATE_KEY?.trim() === zeroKey) {
    throw new Error('DEPLOYER_PRIVATE_KEY is still the .env.example placeholder');
  }
  const rpc = process.env.SEPOLIA_RPC_URL ?? '';
  if (rpc.includes('YOUR_INFURA_KEY') || rpc.includes('YOUR_')) {
    throw new Error('SEPOLIA_RPC_URL still contains a .env.example placeholder');
  }
}

export async function preflight(): Promise<PreflightResult> {
  const lines: string[] = [];
  const ok = (label: string, detail: string) => lines.push(`  [ok]   ${label}: ${detail}`);

  rejectPlaceholders();

  // --- 4. Verify the RPC URL and the chain behind it -------------------------
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (FORBIDDEN_CHAIN_IDS[chainId]) {
    throw new Error(
      `REFUSING TO PROCEED: RPC reports chain id ${chainId} (${FORBIDDEN_CHAIN_IDS[chainId]}). ` +
        'This project deploys to Ethereum Sepolia only.',
    );
  }
  // Narrow, explicit escape hatch for exercising the deployment pipeline against
  // a local node. Scoped to the Hardhat chain id only, and checked AFTER the
  // forbidden-chain list, so it can never be used to reach a real network.
  const localAllowed = chainId === LOCAL_CHAIN_ID && process.env.ALLOW_LOCAL_DEPLOY === '1';

  if (chainId !== SEPOLIA_CHAIN_ID && !localAllowed) {
    throw new Error(
      `Wrong network: RPC reports chain id ${chainId}, expected ${SEPOLIA_CHAIN_ID} (Sepolia). ` +
        'Check SEPOLIA_RPC_URL.',
    );
  }
  ok('chain id', localAllowed ? `${chainId} (LOCAL DRY RUN)` : `${chainId} (Ethereum Sepolia)`);

  // Cheap liveness signal, and it catches an RPC that answers eth_chainId from
  // a cache while being unable to serve anything else.
  const blockNumber = await publicClient.getBlockNumber();
  ok('rpc reachable', `head block ${blockNumber}`);

  // --- 5. Verify the deployer ------------------------------------------------
  const [deployerClient] = await hre.viem.getWalletClients();
  if (!deployerClient) {
    throw new Error('No signer available. Is DEPLOYER_PRIVATE_KEY set?');
  }
  const deployer = getAddress(deployerClient.account.address);
  const deployerBalance = await publicClient.getBalance({ address: deployer });

  ok('deployer', deployer);
  ok('deployer balance', `${formatEther(deployerBalance)} ETH`);

  if (deployerBalance < MIN_DEPLOYER_BALANCE_WEI) {
    throw new Error(
      `Deployer balance ${formatEther(deployerBalance)} ETH is below the ` +
        `${formatEther(MIN_DEPLOYER_BALANCE_WEI)} ETH minimum. Fund it from a Sepolia faucet.`,
    );
  }

  // --- 6. Verify constructor parameters --------------------------------------
  const swapRouter = requireAddressEnv('UNISWAP_SWAP_ROUTER_02');
  const weth = requireAddressEnv('WETH_ADDRESS');

  // Admin defaults to the deployer for a testnet deploy. In production this
  // should be a multisig or timelock, never the deploying EOA.
  const admin = process.env.CONTRACT_ADMIN_ADDRESS
    ? requireAddressEnv('CONTRACT_ADMIN_ADDRESS')
    : deployer;

  // The executor is deliberately address(0) at construction. EXECUTOR_ROLE is
  // granted by configure.ts in a separate transaction, so the deployer key never
  // transiently holds execution rights and the grant is independently auditable.
  const executor = zeroAddress;

  // Both external addresses must actually be contracts on this chain. A
  // correctly-formatted address that holds no code is the classic
  // wrong-network-constant bug, and it only surfaces at the first swap.
  for (const [label, address] of [
    ['swapRouter', swapRouter],
    ['weth', weth],
  ] as const) {
    const code = await publicClient.getCode({ address });
    if (!code || code === '0x') {
      throw new Error(
        `${label} ${address} has no bytecode on chain ${chainId}. ` +
          'Wrong address or wrong network.',
      );
    }
    ok(`${label} has code`, `${address} (${(code.length - 2) / 2} bytes)`);
  }

  ok('admin', `${admin}${admin === deployer ? ' (deployer — use a multisig in production)' : ''}`);

  console.log('\nPre-flight checks\n' + lines.join('\n') + '\n');

  return {
    chainId,
    deployer,
    deployerBalance,
    swapRouter,
    weth,
    admin,
    executor,
    executorIsZero: true,
  };
}

if (require.main === module) {
  preflight()
    .then(() => {
      console.log('All pre-flight checks passed. Safe to run script/deploy.ts.\n');
    })
    .catch((error: unknown) => {
      console.error(`\nPRE-FLIGHT FAILED: ${error instanceof Error ? error.message : error}\n`);
      process.exitCode = 1;
    });
}
