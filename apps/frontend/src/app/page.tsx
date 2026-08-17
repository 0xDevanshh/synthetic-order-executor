'use client';

import { useCallback, useEffect, useState } from 'react';
import { CreateOrderForm } from '@/components/CreateOrderForm';
import { OrderTable } from '@/components/OrderTable';
import { PriceTicker } from '@/components/PriceTicker';
import { ConnectWallet } from '@/components/ConnectWallet';
import { useWallet } from '@/hooks/useWallet';
import { api, type Order } from '@/lib/api';

/**
 * Single-page demo of the full pipeline.
 *
 * The connected wallet address is the order owner. It is the same address that
 * must hold a vault balance in the contract — the executor debits that balance
 * and credits the proceeds straight back to it, so an order for an address with
 * no deposit will fail its pre-flight check.
 */
export default function Page() {
  const wallet = useWallet();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const address = wallet.address;

  const refresh = useCallback(async () => {
    try {
      // No wallet, no orders. Showing every user's orders to an unconnected
      // visitor would be wrong, and filtering by a placeholder address would be
      // worse — it would look like the connected user has orders they don't.
      setOrders(address ? await api.listOrders(address) : []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Poll rather than subscribe. Order state changes come from three independent
  // background workers, so no single request's response could carry the final
  // status — polling is the honest model for this system.
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const ready = Boolean(address) && !wallet.wrongNetwork;

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Synthetic Order Executor</h1>
        <p className="text-sm text-muted-foreground">
          Off-chain trigger detection, on-chain constrained execution · Ethereum Sepolia
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <PriceTicker />
        <ConnectWallet wallet={wallet} />
      </div>

      {ready ? (
        <CreateOrderForm userAddress={address!} onCreated={refresh} />
      ) : (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {wallet.wrongNetwork
              ? 'Switch your wallet to Sepolia to create orders.'
              : 'Connect your wallet to create an order.'}
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not reach the API: {error}
        </p>
      )}

      {address && <OrderTable orders={orders} loading={loading} onChanged={refresh} />}

      <footer className="pt-2 text-xs text-muted-foreground">
        Contract{' '}
        <a
          href="https://sepolia.etherscan.io/address/0x34C7244383f129957e631706AA420D5CFF721c35"
          target="_blank"
          rel="noreferrer"
          className="font-mono underline underline-offset-2"
        >
          0x34C7244383f129957e631706AA420D5CFF721c35
        </a>{' '}
        · chain 11155111
      </footer>
    </main>
  );
}
