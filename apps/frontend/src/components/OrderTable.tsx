'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from '@/components/StatusBadge';
import { api, ETHERSCAN_TX, type Order } from '@/lib/api';

/** Only these two are cancellable — matches the backend state machine exactly. */
const CANCELLABLE = new Set(['PENDING', 'TRIGGERED']);

export function OrderTable({
  orders,
  loading,
  onChanged,
}: {
  orders: Order[];
  loading: boolean;
  onChanged: () => void;
}) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancel = async (id: string) => {
    setCancelling(id);
    setError(null);
    try {
      await api.cancelOrder(id);
      onChanged();
    } catch (err) {
      // A 409 here is normal, not a bug: the watcher can claim an order between
      // the page render and the click.
      setError((err as Error).message);
    } finally {
      setCancelling(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders</CardTitle>
        <CardDescription>
          {loading && orders.length === 0 ? 'Loading…' : `${orders.length} order(s) · auto-refreshing`}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {error && (
          <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {orders.length === 0 && !loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No orders yet. Create one above.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Transaction</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>

            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <div className="font-medium">
                      {order.side} {order.amount} {order.tokenIn}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      → {order.tokenOut} · {new Date(order.createdAt).toLocaleString()}
                    </div>
                  </TableCell>

                  <TableCell className="tabular-nums">
                    {order.side === 'SELL' ? '≤' : '≥'} ${order.triggerPrice}
                  </TableCell>

                  <TableCell>
                    <StatusBadge status={order.status} />
                    {order.errorMessage && (
                      <div
                        className="mt-1 max-w-[22rem] truncate text-xs text-muted-foreground"
                        title={order.errorMessage}
                      >
                        {order.errorMessage}
                      </div>
                    )}
                  </TableCell>

                  <TableCell>
                    {order.txHash ? (
                      <a
                        href={`${ETHERSCAN_TX}${order.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs underline underline-offset-2"
                      >
                        {order.txHash.slice(0, 10)}…{order.txHash.slice(-8)}
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  <TableCell className="text-right">
                    {CANCELLABLE.has(order.status) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cancelling === order.id}
                        onClick={() => cancel(order.id)}
                      >
                        {cancelling === order.id ? 'Cancelling…' : 'Cancel'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
