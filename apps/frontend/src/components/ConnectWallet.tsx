'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { shortenAddress } from '@/lib/wallet';
import type { WalletState } from '@/hooks/useWallet';

export function ConnectWallet({ wallet }: { wallet: WalletState }) {
  const { address, installed, connecting, error, wrongNetwork } = wallet;

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">Wallet</div>

          {address ? (
            <div className="truncate font-mono text-sm" title={address}>
              {shortenAddress(address)}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Not connected</div>
          )}

          {wrongNetwork && (
            <div className="mt-0.5 text-xs text-destructive">Wrong network — switch to Sepolia</div>
          )}
          {error && <div className="mt-0.5 text-xs text-destructive">{error}</div>}
        </div>

        <div className="shrink-0">
          {!installed ? (
            <Button asChild variant="outline" size="sm">
              <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                Install MetaMask
              </a>
            </Button>
          ) : wrongNetwork ? (
            <Button size="sm" onClick={() => void wallet.switchNetwork()}>
              Switch to Sepolia
            </Button>
          ) : address ? (
            <Button variant="outline" size="sm" onClick={wallet.disconnect}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" disabled={connecting} onClick={() => void wallet.connect()}>
              {connecting ? 'Connecting…' : 'Connect Wallet'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
