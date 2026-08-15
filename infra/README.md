# Infrastructure

| Component | Local | Deployed |
|---|---|---|
| PostgreSQL | Neon branch (or `--profile local-db`) | Neon |
| Redis | Docker container | Managed Redis (Upstash / Redis Cloud) |
| API | `pnpm dev:backend` | `Dockerfile.backend` |
| Worker | `pnpm dev:worker` | `Dockerfile.worker` |
| Frontend | `pnpm dev:frontend` | Vercel |
| Contracts | Hardhat node / Sepolia fork | Ethereum Sepolia (11155111) |

## Why Neon rather than a local Postgres container

Branching. Every developer and every CI run gets an isolated database from the
same base schema in seconds, so integration tests can run against real Postgres
without sharing state. Dev and production then exercise the same engine version
and the same pooled-connection semantics, which is where container-vs-managed
drift usually bites.

The one thing to keep straight is the two connection strings:

- `DATABASE_URL` — pooled (PgBouncer), used by the API and worker at runtime.
- `DIRECT_DATABASE_URL` — direct, used by `prisma migrate`, which cannot run
  through PgBouncer.

## Process separation

The API and the worker are separate deployables on purpose: only the worker
image ever receives `EXECUTOR_PRIVATE_KEY`. The signing key is therefore never
resident in a process that terminates public HTTP traffic.
