import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma client.
 *
 * Stashed on globalThis so tsx/vitest hot reloads reuse one instance. Without
 * this, every reload opens a fresh connection pool against Neon and exhausts
 * the connection limit within a few edits.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
