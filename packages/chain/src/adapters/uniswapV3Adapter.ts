import type { DexAdapter } from '@soe/shared';

/**
 * Uniswap V3 implementation of DexAdapter. Read-only: it quotes, it never
 * submits. All settlement goes through SyntheticOrderExecutor so the on-chain
 * constraints cannot be bypassed.
 *
 * Two details that are easy to get wrong:
 *
 *   1. QuoterV2.quoteExactInputSingle is state-mutating by design (it reverts
 *      internally and decodes the revert payload), so it must be called with
 *      `simulateContract`, never `readContract`.
 *
 *   2. Probe all configured fee tiers and take the best output. Sepolia
 *      liquidity is unevenly distributed across tiers, so hardcoding 3000
 *      produces spurious "no liquidity" failures.
 */
export const uniswapV3Adapter: DexAdapter = {
  name: 'uniswap-v3',

  async getQuote() {
    // TODO(impl): probe UNISWAP_POOL_FEE_TIERS, discard tiers whose pool is
    //             missing or empty, return the best amountOut with its tier.
    throw new Error('TODO: implement getQuote');
  },

  async hasLiquidity() {
    // TODO(impl): factory.getPool -> non-zero address -> pool.liquidity() > 0
    throw new Error('TODO: implement hasLiquidity');
  },
};
