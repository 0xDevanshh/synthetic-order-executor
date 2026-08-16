'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CreateOrderForm } from '@/components/CreateOrderForm';
import { OrderTable } from '@/components/OrderTable';
import { PriceTicker } from '@/components/PriceTicker';
import { api, type Order } from '@/lib/api';

const STORAGE_KEY = 'soe:userAddress';
const DEMO_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/**
 * Single-page demo of the full pipeline.
 *
 * The address is typed rather than wallet-connected. That is a deliberate
 * simplification: this page exists to demonstrate the execution system, and a
 * wallet connector would add a dependency without exercising any more of it.
 * Real deposits still require the wallet, since only the depositor can withdraw.
 */
export default function Page() {
  const [userAddress, setUserAddress] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUserAddress(window.localStorage.getItem(STORAGE_KEY) ?? DEMO_ADDRESS);
  }, []);

  useEffect(() => {
    if (userAddress) window.localStorage.setItem(STORAGE_KEY, userAddress);
  }, [userAddress]);

  const refresh = useCallback(async () => {
    try {
      const isValid = /^0x[a-fA-F0-9]{40}$/.test(userAddress);
      setOrders(await api.listOrders(isValid ? userAddress : undefined));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [userAddress]);

  // Poll rather than subscribe. Order state changes come from three independent
  // background workers, so there is no single request whose response could carry
  // the final status — polling is the honest model for this system.
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

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

        <Card>
          <CardContent className="space-y-1.5 p-4">
            <Label htmlFor="address">Wallet address</Label>
            <Input
              id="address"
              value={userAddress}
              onChange={(e) => setUserAddress(e.target.value.trim())}
              placeholder="0x…"
              className="font-mono text-xs"
            />
          </CardContent>
        </Card>
      </div>

      <CreateOrderForm userAddress={userAddress} onCreated={refresh} />

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not reach the API: {error}
        </p>
      )}

      <OrderTable orders={orders} loading={loading} onChanged={refresh} />

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
