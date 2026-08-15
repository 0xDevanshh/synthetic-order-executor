# synthetic-order-executor

Synthetic trading orders — *"Sell 0.01 ETH when ETH falls below $3500"* — with
off-chain trigger detection and on-chain constrained execution through Uniswap
V3 on **Ethereum Sepolia (chain id 11155111)**.

## The core idea

**The backend decides WHEN. The contract enforces HOW.**

| | |
|---|---|
| Off-chain | "Sell ETH when ETH <= $3500" — price watching, trigger evaluation, quoting, transaction lifecycle |
| On-chain | "An authorized executor may swap an *allowlisted* pair, within a *size cap*, above a *user-signed minimum output*, before a *deadline*, exactly *once*" |

The contract is not the order engine. It is the constraint layer the engine must
pass through.

## Two design decisions worth knowing up front

**1. The contract is a per-user vault, not an allowance spender.** Users deposit;
balances are tracked per `(user, token)`. Swap output is credited back to the
same user. Only the user can withdraw, and withdrawal works even while the
contract is paused. There is no admin path to user funds.

**2. Every order carries an EIP-712 signature from its owner.** A fully
compromised backend cannot invent orders — it can only execute orders the user
actually authorized, and it may only *tighten* the signed `minAmountOut`, never
loosen it. Compromising the hot key yields griefing, not theft.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Solidity, Hardhat, contract tests, deployment scripts |
| `apps/backend/` | Express API. Reads and stores. Never signs a transaction. |
| `apps/worker/` | BullMQ execution engine. The only process holding the hot key. |
| `apps/frontend/` | Next.js + Tailwind UI |
| `packages/shared/` | Order / OrderStatus / DexAdapter / PriceProvider / ExecutionResult types, EIP-712 definitions, state machine |
| `packages/database/` | Prisma schema and client (Neon PostgreSQL) |
| `packages/chain/` | viem clients, Uniswap adapter, price providers |
| `infra/docker/` | Redis for local dev, deployment Dockerfiles |

## Quick start

```bash
pnpm install

# 1. Redis (Postgres comes from Neon — see infra/README.md)
pnpm infra:up

# 2. Environment
cp .env.example .env     # fill in Neon URLs, an RPC, and test keys

# 3. Database
pnpm db:generate && pnpm db:migrate

# 4. Contracts
pnpm contracts:build && pnpm test:contracts

# 5. Deploy to Sepolia, then paste the address into .env
pnpm contracts:deploy:sepolia
pnpm contracts:configure:sepolia
pnpm abi:sync

# 6. Run everything
pnpm dev
```

> Never commit a real `.env`. `EXECUTOR_PRIVATE_KEY` should be a throwaway
> testnet key funded with Sepolia ETH for gas only.

## Order lifecycle

```
PENDING --trigger--> TRIGGERED --claim--> EXECUTING --receipt--> EXECUTED
   |                     |                    |
 cancel                cancel            revert / dropped
   v                     v                    v
CANCELLED            CANCELLED             FAILED --retry--> TRIGGERED
```

`EXECUTING` is never left on ambiguity. If a transaction's outcome is unknown,
the order stays `EXECUTING` and the reconciler resolves it against
`consumedOrders[orderHash]` on-chain.

## Why duplicate execution is impossible

Four independent layers, any one of which suffices:

1. **On-chain** — `consumedOrders[orderHash]`, set before any external call.
2. **Database** — atomic conditional claim on `(status, version)`.
3. **Queue** — `jobId = orderId` deduplicates enqueues.
4. **API** — `orderHash` is unique; `(userId, nonce)` is unique.

Layer 1 is the one that actually matters — it holds even against a fully
compromised backend.

Full design rationale: `ARCHITECTURE.md`.
