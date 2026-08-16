const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type OrderStatus =
  | 'PENDING'
  | 'TRIGGERED'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'FAILED'
  | 'CANCELLED';

export interface Order {
  id: string;
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  side: 'BUY' | 'SELL';
  /** Decimal STRING. Never parse to a number — 1e18 is not float-representable. */
  amount: string;
  triggerPrice: string;
  status: OrderStatus;
  executionId: string;
  txHash: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PriceQuote {
  pair: string;
  price: string;
  source: string;
  observedAt: string;
  ageSeconds: number;
}

export interface CreateOrderInput {
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  side: 'BUY' | 'SELL';
  amount: string;
  triggerPrice: string;
}

/** Surfaces the API's machine-readable error code so the UI can be specific. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    cache: 'no-store',
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `Request failed (${response.status})`,
      response.status,
    );
  }

  return body.data as T;
}

export const api = {
  createOrder: (input: CreateOrderInput) =>
    request<Order>('/api/orders', { method: 'POST', body: JSON.stringify(input) }),

  listOrders: (userAddress?: string) =>
    request<Order[]>(
      `/api/orders${userAddress ? `?userAddress=${userAddress}&limit=50` : '?limit=50'}`,
    ),

  getOrder: (id: string) => request<Order>(`/api/orders/${id}`),

  cancelOrder: (id: string) => request<Order>(`/api/orders/${id}/cancel`, { method: 'POST' }),

  getPrice: (pair = 'ETH/USD') => request<PriceQuote>(`/api/prices/${encodeURIComponent(pair)}`),
};

export const ETHERSCAN_TX = 'https://sepolia.etherscan.io/tx/';
