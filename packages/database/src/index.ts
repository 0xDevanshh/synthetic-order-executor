/**
 * Shared Prisma client for the API and worker processes.
 *
 * Neon note: DATABASE_URL points at the pooled (PgBouncer) endpoint, so keep
 * the per-process connection_limit low and let the pooler multiplex. Prisma
 * migrations use DIRECT_DATABASE_URL instead, since PgBouncer cannot run them.
 */
export { PrismaClient, Prisma } from '@prisma/client';
export type {
  User,
  Order,
  ExecutionAttempt,
  PriceTick,
  ReconciliationLog,
  IndexerCheckpoint,
  OrderStatus as PrismaOrderStatus,
  OrderSide as PrismaOrderSide,
  TriggerType as PrismaTriggerType,
  TxStatus as PrismaTxStatus,
} from '@prisma/client';

export { prisma } from './client.js';
