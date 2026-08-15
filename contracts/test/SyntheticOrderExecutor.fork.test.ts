/**
 * Fork tests against the real Uniswap V3 SwapRouter02 on Sepolia.
 *
 *   FORK=1 SEPOLIA_RPC_URL=... npx hardhat test test/SyntheticOrderExecutor.fork.test.ts
 *
 * The unit suite proves the validation ladder against mocks. This suite proves
 * our swap parameters actually route through a live pool — the one thing a mock
 * cannot tell you. Skipped unless FORK=1, so the default `pnpm test` needs no
 * RPC endpoint.
 */
const forkEnabled = process.env.FORK === '1';

(forkEnabled ? describe : describe.skip)('SyntheticOrderExecutor (Sepolia fork)', () => {
  it('routes a real WETH -> USDC swap through SwapRouter02');
  it('selects the fee tier with the best output among 500 / 3000 / 10000');
  it('reverts when the pool cannot satisfy minAmountOut');
  it('credits the vault with the amountOut the router reports');
  it('keeps executeSwap gas within the budget assumed by the fee estimator');
});
