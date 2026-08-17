/**
 * Minimal EIP-1193 wallet access.
 *
 * Talks to `window.ethereum` directly rather than pulling in a connector
 * library. The page needs one address and one network check — a full connector
 * stack would be more dependency than feature.
 */

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7';

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, handler: (...args: never[]) => void): void;
  removeListener(event: string, handler: (...args: never[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function getProvider(): Eip1193Provider | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.ethereum;
}

export function isWalletInstalled(): boolean {
  return Boolean(getProvider());
}

/** Prompts the extension. Throws if the user rejects. */
export async function requestAccounts(): Promise<string[]> {
  const provider = getProvider();
  if (!provider) throw new Error('No wallet found. Install MetaMask to continue.');
  return (await provider.request({ method: 'eth_requestAccounts' })) as string[];
}

/** Already-authorised accounts. Does NOT prompt — safe to call on page load. */
export async function getAccounts(): Promise<string[]> {
  const provider = getProvider();
  if (!provider) return [];
  try {
    return (await provider.request({ method: 'eth_accounts' })) as string[];
  } catch {
    return [];
  }
}

export async function getChainId(): Promise<number | undefined> {
  const provider = getProvider();
  if (!provider) return undefined;
  try {
    const hex = (await provider.request({ method: 'eth_chainId' })) as string;
    return Number.parseInt(hex, 16);
  } catch {
    return undefined;
  }
}

/**
 * Ask the wallet to switch to Sepolia, adding the network if it is unknown.
 *
 * Error 4902 means "this chain is not in the wallet yet", which is a request to
 * add it rather than a failure.
 */
export async function switchToSepolia(): Promise<void> {
  const provider = getProvider();
  if (!provider) throw new Error('No wallet found.');

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
    });
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code !== 4902) throw error;

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: SEPOLIA_CHAIN_ID_HEX,
          chainName: 'Sepolia',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
        },
      ],
    });
  }
}

/** 0x1234…abcd */
export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
