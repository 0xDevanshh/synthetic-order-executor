import hre from 'hardhat';
import { expect } from 'chai';
import { parseUnits, getAddress, type Address } from 'viem';

/** Uniswap V3 fee tier used throughout the unit suite (0.3%). */
export const POOL_FEE = 3000;

export const ONE_WETH = parseUnits('1', 18);
export const MAX_TRADE_WETH = parseUnits('1', 18);
export const MAX_TRADE_USDC = parseUnits('5000', 6);

/**
 * Assert that a call reverts with a specific custom error.
 *
 * viem surfaces the decoded error name inside the thrown error's message when
 * the ABI is available, so matching on the name is both precise and readable.
 * Matching on the name rather than a substring of a string reason is what keeps
 * these assertions honest — a different revert cannot accidentally satisfy them.
 */
export async function expectRevert(promise: Promise<unknown>, errorName: string): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    expect(
      message,
      `expected revert with "${errorName}", got:\n${message}`,
    ).to.include(errorName);
    return;
  }
  expect.fail(`expected revert with "${errorName}" but the call succeeded`);
}

/** Current block timestamp plus `seconds`, as a uint256-safe bigint. */
export async function futureDeadline(seconds = 3600): Promise<bigint> {
  const publicClient = await hre.viem.getPublicClient();
  const block = await publicClient.getBlock();
  return block.timestamp + BigInt(seconds);
}

/**
 * Standard test environment:
 *   - tokenIn  : 18-decimal WETH-like ERC20, allowlisted, cap 1e18
 *   - tokenOut : 6-decimal USDC-like ERC20, allowlisted, cap 5000e6
 *   - router   : MockSwapRouter, pre-funded with tokenOut liquidity
 *   - user     : holds 10 tokenIn, has deposited 1 tokenIn into the vault
 */
export async function deployExecutorFixture() {
  const [admin, executor, user, other, recipient] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const tokenIn = await hre.viem.deployContract('MockERC20', ['Wrapped Ether', 'WETH', 18]);
  const tokenOut = await hre.viem.deployContract('MockERC20', ['USD Coin', 'USDC', 6]);
  const weth = await hre.viem.deployContract('MockWETH9', []);
  const router = await hre.viem.deployContract('MockSwapRouter', []);

  const soe = await hre.viem.deployContract('SyntheticOrderExecutor', [
    router.address,
    weth.address,
    admin.account.address,
    executor.account.address,
  ]);

  // Allowlist both traded tokens plus WETH (for the ETH deposit path).
  await soe.write.setTokenAllowed([tokenIn.address, MAX_TRADE_WETH], {
    account: admin.account,
  });
  await soe.write.setTokenAllowed([tokenOut.address, MAX_TRADE_USDC], {
    account: admin.account,
  });
  await soe.write.setTokenAllowed([weth.address, MAX_TRADE_WETH], {
    account: admin.account,
  });

  // Fund the router so it can actually pay out, and the user so they can deposit.
  await tokenOut.write.mint([router.address, parseUnits('1000000', 6)]);
  await tokenIn.write.mint([user.account.address, parseUnits('10', 18)]);

  // User deposits 1 tokenIn into their vault.
  await tokenIn.write.approve([soe.address, ONE_WETH], { account: user.account });
  await soe.write.deposit([tokenIn.address, ONE_WETH], { account: user.account });

  return {
    soe,
    router,
    tokenIn,
    tokenOut,
    weth,
    admin,
    executor,
    user,
    other,
    recipient,
    publicClient,
  };
}

/**
 * Typed accessor for decoded event arguments.
 *
 * hardhat-viem returns a generic `Abi`, so event args come back as
 * `Record<string, unknown>`. Narrowing here in one place keeps the assertions
 * themselves readable and type-checked.
 */
export function eventArgs<T>(event: { args: unknown }): T {
  return event.args as T;
}

export interface SwapExecutedArgs {
  executionId: `0x${string}`;
  owner: Address;
  executorAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  poolFee: number;
}

/** Deterministic execution ids, so tests read clearly. */
export function executionId(label: string): `0x${string}` {
  const hex = Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64);
  return `0x${hex}`;
}

export function addr(value: string): Address {
  return getAddress(value);
}
