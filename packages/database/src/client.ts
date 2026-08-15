import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma client.
 *
 * TODO(impl): guard against duplicate instances across hot reloads via
 * globalThis, and wire query logging off LOG_LEVEL.
 */
export const prisma = new PrismaClient();
