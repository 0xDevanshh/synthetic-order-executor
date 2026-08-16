/**
 * Shared Prisma client for the API and worker processes.
 *
 * Neon note: DATABASE_URL points at the pooled (PgBouncer) endpoint, so keep
 * per-process connection limits low and let the pooler multiplex. Prisma
 * migrations use DIRECT_DATABASE_URL instead, since PgBouncer cannot run them.
 */
export { PrismaClient, Prisma } from '@prisma/client';
export type {
  Order,
  OrderStatus,
  OrderSide,
  IndexerCheckpoint,
  ReconciliationLog,
} from '@prisma/client';

export { prisma } from './client.js';
