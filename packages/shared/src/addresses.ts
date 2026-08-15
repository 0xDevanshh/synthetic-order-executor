import type { Address } from 'viem';

/** The only chain this project targets. */
export const SEPOLIA_CHAIN_ID = 11155111 as const;

/** Public, well-known Sepolia addresses. Not secrets — safe to commit. */
export const SEPOLIA_ADDRESSES = {
  uniswapSwapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
  uniswapQuoterV2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
  uniswapV3Factory: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  chainlinkEthUsdFeed: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
} as const satisfies Record<string, Address>;

/** Uniswap V3 fee tiers, in hundredths of a bip. */
export const FEE_TIERS = [500, 3000, 10000] as const;
export type FeeTier = (typeof FEE_TIERS)[number];

export const TOKEN_DECIMALS = {
  WETH: 18,
  USDC: 6,
} as const;
