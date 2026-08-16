import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { OrderStatus } from '@/lib/api';

/**
 * All six lifecycle states, colour-coded by what the user should do about them.
 *
 * EXECUTING is deliberately styled as "in progress" rather than success: a
 * transaction is in flight and its outcome is genuinely not known yet. Showing
 * it as done would be the UI making a claim the system carefully avoids making.
 */
const STYLES: Record<OrderStatus, string> = {
  PENDING: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  TRIGGERED: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  EXECUTING: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  EXECUTED: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  FAILED: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  CANCELLED: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};

const DESCRIPTIONS: Record<OrderStatus, string> = {
  PENDING: 'Waiting for the trigger price',
  TRIGGERED: 'Condition met, queued for execution',
  EXECUTING: 'Transaction submitted, awaiting confirmation',
  EXECUTED: 'Confirmed on-chain',
  FAILED: 'Execution did not complete',
  CANCELLED: 'Cancelled before execution',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge variant="outline" className={cn('border-0', STYLES[status])} title={DESCRIPTIONS[status]}>
      {status}
    </Badge>
  );
}
