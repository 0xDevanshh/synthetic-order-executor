/**
 * Wrap ETH to WETH and deposit it into the SyntheticOrderExecutor vault.
 *
 *   DEPOSIT_ETH=0.02 npx hardhat run script/depositVault.ts --network sepolia
 *
 * Three transactions, each awaited to a receipt before the next is sent:
 *   1. WETH.deposit{value}        wrap ETH
 *   2. WETH.approve(executor)     allow the vault to pull it
 *   3. executor.deposit(WETH, n)  credit your vault balance
 *
 * The deposited WETH remains yours: only the depositing address can withdraw
 * it, and withdrawal works even if the contract is paused. This script cannot
 * move anyone else's funds.
 */
import hre from 'hardhat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatEther, formatUnits, getAddress, parseEther } from 'viem';
import 'dotenv/config';

const SEPOLIA_CHAIN_ID = 11155111;

const wethAbi = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

async function main(): Promise<void> {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`Refusing to run: chain id ${chainId} is not Sepolia.`);
  }

  const [wallet] = await hre.viem.getWalletClients();
  if (!wallet) throw new Error('No signer available. Is DEPLOYER_PRIVATE_KEY set?');

  const me = getAddress(wallet.account.address);
  const weth = getAddress(process.env.WETH_ADDRESS!);
  const deployment = JSON.parse(
    readFileSync(join(__dirname, '..', 'deployments', 'sepolia.json'), 'utf8'),
  ) as { address: `0x${string}` };
  const executorContract = getAddress(deployment.address);

  const amount = parseEther(process.env.DEPOSIT_ETH ?? '0.02');

  console.log('\n=== Vault deposit ===\n');
  console.log(`  from     : ${me}`);
  console.log(`  contract : ${executorContract}`);
  console.log(`  amount   : ${formatEther(amount)} ETH -> WETH\n`);

  const gas = await publicClient.getBalance({ address: me });
  if (gas < amount + parseEther('0.005')) {
    throw new Error(
      `Insufficient balance: have ${formatEther(gas)} ETH, need ${formatEther(amount)} plus gas.`,
    );
  }

  // Each step waits for its receipt. A write that has not been mined has not
  // happened, and the next step depends on the previous one having landed.
  const send = async (label: string, hash: `0x${string}`) => {
    process.stdout.write(`  ${label} ... `);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`${label} reverted (${hash})`);
    console.log(`mined in block ${receipt.blockNumber}`);
    return receipt;
  };

  // 1. Wrap.
  await send(
    'WETH.deposit',
    await wallet.writeContract({
      address: weth,
      abi: wethAbi,
      functionName: 'deposit',
      value: amount,
      chain: null,
      account: wallet.account,
    }),
  );

  // 2. Approve exactly the deposit amount, never an unbounded allowance.
  await send(
    'WETH.approve',
    await wallet.writeContract({
      address: weth,
      abi: wethAbi,
      functionName: 'approve',
      args: [executorContract, amount],
      chain: null,
      account: wallet.account,
    }),
  );

  // 3. Deposit into the vault.
  const soe = await hre.viem.getContractAt('SyntheticOrderExecutor', executorContract);
  await send(
    'executor.deposit',
    await soe.write.deposit([weth, amount], { account: wallet.account }),
  );

  // Read the result back from chain state rather than assuming success.
  const vaultBalance = (await soe.read.getBalance([me, weth])) as bigint;
  const held = (await publicClient.readContract({
    address: weth,
    abi: wethAbi,
    functionName: 'balanceOf',
    args: [executorContract],
  })) as bigint;

  console.log(`\n  your vault balance : ${formatUnits(vaultBalance, 18)} WETH`);
  console.log(`  contract holds     : ${formatUnits(held, 18)} WETH`);

  if (vaultBalance < amount) {
    throw new Error('Vault balance did not increase as expected. Investigate before proceeding.');
  }

  console.log('\n  Deposit confirmed. Only this address can withdraw it.\n');
}

main().catch((error: unknown) => {
  console.error(`\nDEPOSIT FAILED: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
