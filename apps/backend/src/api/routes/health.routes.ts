import { Router, type Router as ExpressRouter } from 'express';
import { prisma } from '@soe/database';

import { getPublicClient, getExecutorClient, getChainConfig } from '../../blockchain/executor.js';

export const healthRoutes: ExpressRouter = Router();

/** Liveness. Touches no dependency, so it stays up even when Neon is down. */
healthRoutes.get('/', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/**
 * Readiness. Checks Neon, the Sepolia RPC and the contract.
 *
 * Reports per-dependency status instead of a single boolean, because "the API
 * is up but the RPC is lagging" and "the database is unreachable" need very
 * different responses from whoever is paged.
 */
healthRoutes.get('/deep', async (_req, res) => {
  const chain = getChainConfig();
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true };
  } catch (error) {
    checks.database = { ok: false, detail: (error as Error).message };
  }

  try {
    const chainId = await getPublicClient().getChainId();
    checks.rpc = {
      ok: chainId === chain.chainId,
      detail: `chainId=${chainId}`,
    };
  } catch (error) {
    checks.rpc = { ok: false, detail: (error as Error).message };
  }

  try {
    const config = await getExecutorClient().getState();
    checks.contract = {
      ok: !config.paused,
      detail: config.paused ? 'contract is PAUSED' : `executor=${config.executor}`,
    };
  } catch (error) {
    checks.contract = { ok: false, detail: (error as Error).message };
  }

  const healthy = Object.values(checks).every((c) => c.ok);
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
});
