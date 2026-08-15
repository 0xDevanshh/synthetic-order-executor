/**
 * Live Sepolia verification of the execution pipeline. READ-ONLY.
 *
 *   npx tsx scripts/verifySepolia.ts
 *
 * Exercises the real path against the deployed contract and real Uniswap:
 * contract state, fresh QuoterV2 quotes across every fee tier, minAmountOut
 * derivation, and an executeSwap simulation.
 *
 * Every call is an eth_call. Nothing is signed, nothing is broadcast, no value
 * moves. Safe to run at any time, including against a funded deployment.
 */
import { getAddress, formatUnits, parseUnits, keccak256, toHex } from 'viem';

import { loadChainConfig } from '../src/config.js';
import { createReadClient, assertChain } from '../src/clients.js';
import { ExecutorContractClient } from '../src/contract/executorClient.js';
import { UniswapAdapter } from '../src/dex/uniswapAdapter.js';

const PUBLIC_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

async function main(): Promise<void> {
  const config = loadChainConfig({
    CHAIN_ID: '11155111',
    SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL ?? PUBLIC_SEPOLIA_RPC,
    EXECUTOR_CONTRACT_ADDRESS:
      process.env.EXECUTOR_CONTRACT_ADDRESS ?? '0x34C7244383f129957e631706AA420D5CFF721c35',
    ...process.env,
  } as NodeJS.ProcessEnv);

  const client = createReadClient(config);
  await assertChain(client, config.chainId);

  const executor = new ExecutorContractClient(config, client);
  const dex = new UniswapAdapter(config, executor, client);

  console.log('\n=== Sepolia execution pipeline verification (read-only) ===\n');
  console.log(`  chain id : ${await client.getChainId()}`);
  console.log(`  contract : ${config.executorContract}`);
  console.log(`  block    : ${await client.getBlockNumber()}\n`);

  // --- 1. Contract state -----------------------------------------------------
  const state = await executor.getState();
  console.log('Contract state');
  console.log(`  paused          : ${state.paused}`);
  console.log(`  executor        : ${state.executor}`);
  console.log(`  swapRouter      : ${state.swapRouter}`);
  console.log(
    `  router matches  : ${state.swapRouter.toLowerCase() === config.swapRouter.toLowerCase()}`,
  );
  console.log(`  WETH allowed    : ${await executor.isTokenAllowed(config.weth)}`);
  console.log(`  USDC allowed    : ${await executor.isTokenAllowed(config.usdc)}`);
  console.log(
    `  WETH max trade  : ${formatUnits(await executor.getMaxTradeAmount(config.weth), 18)} WETH\n`,
  );

  // --- 2. Fresh quotes across every fee tier ---------------------------------
  const amountIn = parseUnits('0.01', 18);
  console.log(`Uniswap V3 quotes for ${formatUnits(amountIn, 18)} WETH -> USDC`);

  for (const fee of config.feeTiers) {
    const available = await dex.hasLiquidity(config.weth, config.usdc, fee);
    console.log(`  fee ${String(fee).padStart(5)} : ${available ? 'pool has liquidity' : 'no pool / no liquidity'}`);
  }

  let quote;
  try {
    quote = await dex.getQuote({
      tokenIn: config.weth,
      tokenOut: config.usdc,
      amountIn,
    });
    console.log(`\n  best quote     : ${formatUnits(quote.amountOut, 6)} USDC (fee ${quote.poolFee})`);
    console.log(`  gas estimate   : ${quote.gasEstimate}`);
  } catch (error) {
    console.log(`\n  [!] no quote available: ${(error as Error).message}`);
    console.log('      Sepolia WETH/USDC pools are frequently unfunded. Seed one with');
    console.log('      contracts/script/seedPool.ts to run an end-to-end execution.\n');
  }

  // --- 3. minAmountOut derivation --------------------------------------------
  if (quote) {
    const owner = getAddress(
      process.env.TEST_OWNER ?? '0x0000000000000000000000000000000000000001',
    );
    const executionId = keccak256(toHex('soe:verify:sepolia'));
    const params = dex.buildExecutionParams({ executionId, owner, quote });

    console.log('\nDerived execution parameters');
    console.log(`  quotedOut      : ${formatUnits(quote.amountOut, 6)} USDC`);
    console.log(`  slippage       : ${config.slippageBps} bps`);
    console.log(`  minAmountOut   : ${formatUnits(params.minAmountOut, 6)} USDC`);
    console.log(`  poolFee        : ${params.poolFee}`);
    console.log(`  deadline       : ${params.deadline} (+${config.deadlineWindowSec}s)`);

    // --- 4. Simulate the real contract call ---------------------------------
    console.log('\nSimulating executeSwap against the deployed contract');
    const vaultBalance = await executor.getBalance(owner, config.weth);
    console.log(`  owner vault    : ${formatUnits(vaultBalance, 18)} WETH`);

    try {
      const amountOut = await executor.simulate(params);
      console.log(`  [ok] simulation succeeded, would return ${formatUnits(amountOut, 6)} USDC`);
    } catch (error) {
      const message = (error as Error).message;
      const expected = /InsufficientBalance/.test(message);
      console.log(
        `  [${expected ? 'expected' : 'UNEXPECTED'}] ${message.split('\n')[0]}`,
      );
      if (expected) {
        console.log(
          '      InsufficientBalance is CORRECT here: the test owner has no vault deposit.',
        );
        console.log(
          '      It proves the call reached the contract and passed the allowlist, size-cap,',
        );
        console.log('      deadline and role checks before failing on balance.');
      }
    }
  }

  console.log('\nNo transactions were signed or broadcast.\n');
}

main().catch((error: unknown) => {
  console.error(`\nVERIFICATION FAILED: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
