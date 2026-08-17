'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  SEPOLIA_CHAIN_ID,
  getAccounts,
  getChainId,
  getProvider,
  isWalletInstalled,
  requestAccounts,
  switchToSepolia,
} from '@/lib/wallet';

export interface WalletState {
  address: string | null;
  chainId: number | undefined;
  installed: boolean;
  connecting: boolean;
  error: string | null;
  /** Connected, but pointed at a network this app does not serve. */
  wrongNetwork: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | undefined>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);

  // Restore an existing authorisation without prompting. A page refresh should
  // not force the user through the extension popup again.
  useEffect(() => {
    setInstalled(isWalletInstalled());

    void (async () => {
      const [accounts, chain] = await Promise.all([getAccounts(), getChainId()]);
      if (accounts.length > 0) setAddress(accounts[0]!);
      setChainId(chain);
    })();
  }, []);

  // The user can switch account or network in the extension at any time, and
  // the page must follow rather than keep showing a stale address.
  useEffect(() => {
    const provider = getProvider();
    if (!provider) return;

    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      setAddress(accounts.length > 0 ? accounts[0]! : null);
    };

    const onChain = (...args: never[]) => {
      const hex = args[0] as unknown as string;
      setChainId(Number.parseInt(hex, 16));
    };

    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);

    return () => {
      provider.removeListener('accountsChanged', onAccounts);
      provider.removeListener('chainChanged', onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const accounts = await requestAccounts();
      setAddress(accounts[0] ?? null);
      setChainId(await getChainId());
    } catch (err) {
      // 4001 is the user closing the popup. That is a choice, not an error
      // worth shouting about.
      const code = (err as { code?: number })?.code;
      setError(code === 4001 ? null : (err as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    setError(null);
    try {
      await switchToSepolia();
      setChainId(await getChainId());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  /**
   * Local only. EIP-1193 has no way to revoke a site's authorisation, so this
   * clears the app's view of the wallet — the extension still considers the
   * site connected until the user revokes it there.
   */
  const disconnect = useCallback(() => {
    setAddress(null);
    setError(null);
  }, []);

  return {
    address,
    chainId,
    installed,
    connecting,
    error,
    wrongNetwork: address !== null && chainId !== undefined && chainId !== SEPOLIA_CHAIN_ID,
    connect,
    disconnect,
    switchNetwork,
  };
}
