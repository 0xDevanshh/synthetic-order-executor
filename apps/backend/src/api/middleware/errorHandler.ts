import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@soe/database';

import { AppError } from '../../domain/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Terminal error middleware. Every failure leaves the API through here, in one
 * stable shape:
 *
 *   { error: { code, message, details? } }
 *
 * Internal details — stack traces, connection strings, RPC URLs — never reach
 * the response body. An unrecognised error becomes a generic 500 and is logged
 * in full server-side, because leaking an exception message from a service that
 * holds database credentials is how connection strings end up in bug reports.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof AppError) {
    res.status(error.httpStatus).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  // Unique constraint — in practice a duplicate executionId or txHash.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    res.status(409).json({
      error: {
        code: 'DUPLICATE_RESOURCE',
        message: 'A record with this unique value already exists',
        details: { target: error.meta?.target },
      },
    });
    return;
  }

  logger.error({ err: error }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}
