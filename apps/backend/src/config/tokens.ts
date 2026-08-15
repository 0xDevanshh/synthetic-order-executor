import { getAddress, type Address } from 'viem';
import { loadEnv } from './env.js';
import { TokenNotSupportedError } from '../domain/errors.js';

export interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
}

/**
 * Registry mapping the symbols the API speaks ("ETH", "USDC") to the addresses
 * and decimals the chain speaks.
 *
 * "ETH" resolves to WETH. The vault holds WETH because Uniswap V3 pools trade
 * the wrapped form, and the contract's depositETH path wraps on the way in — so
 * a user thinking in ETH and a pool trading WETH are the same position.
 *
 * Orders store symbols rather than addresses so that redeploying against
 * different token addresses (a fresh testnet pool, say) does not require
 * rewriting stored rows.
 */
export function getTokenRegistry(): Record<string, TokenInfo> {
  const env = loadEnv();
  const weth = getAddress(env.WETH_ADDRESS);
  const usdc = getAddress(env.USDC_ADDRESS);

  return {
    ETH: { symbol: 'ETH', address: weth, decimals: 18 },
    WETH: { symbol: 'WETH', address: weth, decimals: 18 },
    USDC: { symbol: 'USDC', address: usdc, decimals: 6 },
  };
}

export function resolveToken(symbol: string): TokenInfo {
  const token = getTokenRegistry()[symbol.toUpperCase()];
  if (!token) throw new TokenNotSupportedError(symbol);
  return token;
}

export function isSupportedToken(symbol: string): boolean {
  return Boolean(getTokenRegistry()[symbol.toUpperCase()]);
}

export function supportedSymbols(): string[] {
  return Object.keys(getTokenRegistry());
}
