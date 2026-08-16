'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';

export function CreateOrderForm({
  userAddress,
  onCreated,
}: {
  userAddress: string;
  onCreated: () => void;
}) {
  const [side, setSide] = useState<'SELL' | 'BUY'>('SELL');
  const [tokenIn, setTokenIn] = useState('ETH');
  const [tokenOut, setTokenOut] = useState('USDC');
  const [amount, setAmount] = useState('0.01');
  const [triggerPrice, setTriggerPrice] = useState('3500');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      // amount and triggerPrice stay STRINGS all the way to the API. Parsing
      // them to numbers here would quietly corrupt the value the user is
      // committing funds against — the API rejects numbers outright.
      await api.createOrder({ userAddress, tokenIn, tokenOut, side, amount, triggerPrice });
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const summary =
    side === 'SELL'
      ? `SELL ${amount} ${tokenIn} when ${tokenIn} <= $${triggerPrice}`
      : `BUY ${tokenOut} with ${amount} ${tokenIn} when ${tokenOut} >= $${triggerPrice}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create order</CardTitle>
        <CardDescription className="font-mono text-xs">{summary}</CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="side">Side</Label>
              <Select
                id="side"
                value={side}
                onChange={(e) => setSide(e.target.value as 'SELL' | 'BUY')}
              >
                <option value="SELL">SELL</option>
                <option value="BUY">BUY</option>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tokenIn">Token in</Label>
              <Select id="tokenIn" value={tokenIn} onChange={(e) => setTokenIn(e.target.value)}>
                <option value="ETH">ETH</option>
                <option value="WETH">WETH</option>
                <option value="USDC">USDC</option>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tokenOut">Token out</Label>
              <Select id="tokenOut" value={tokenOut} onChange={(e) => setTokenOut(e.target.value)}>
                <option value="USDC">USDC</option>
                <option value="ETH">ETH</option>
                <option value="WETH">WETH</option>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.01"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="triggerPrice">
                Trigger price (USD) {side === 'SELL' ? '— fires at or below' : '— fires at or above'}
              </Label>
              <Input
                id="triggerPrice"
                inputMode="decimal"
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
                placeholder="3500"
              />
            </div>
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={submitting || !userAddress}>
            {submitting ? 'Creating…' : 'Create order'}
          </Button>

          {!userAddress && (
            <p className="text-xs text-muted-foreground">Enter a wallet address above first.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
