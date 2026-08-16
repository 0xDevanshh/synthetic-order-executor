import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { buildOrderRoutes } from './api/routes/order.routes.js';
import { healthRoutes } from './api/routes/health.routes.js';
import { priceRoutes } from './api/routes/price.routes.js';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler.js';
import { orderController, type OrderController } from './api/controllers/order.controller.js';

export interface AppDependencies {
  /** Injectable so the API suite can mount routes over fakes, with no database. */
  orderController?: OrderController;
}

/**
 * Express app assembly, kept separate from the listener so tests can mount it
 * with supertest without binding a port.
 *
 * Middleware order matters: security headers and body parsing first, the
 * 404 handler after all routes, and errorHandler last — Express only treats a
 * four-argument function as error middleware, and only if it is registered
 * after the routes that throw into it.
 */
export function createApp(deps: AppDependencies = {}): Express {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  app.use('/health', healthRoutes);
  app.use('/api/prices', priceRoutes);
  app.use('/api/orders', buildOrderRoutes(deps.orderController ?? orderController));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
