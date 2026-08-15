import { Router, type Router as ExpressRouter } from 'express';
import type { OrderController } from '../controllers/order.controller.js';

/**
 *   POST   /api/orders             create a PENDING order
 *   GET    /api/orders             list, filterable by userAddress and status
 *   GET    /api/orders/:id         fetch one
 *   POST   /api/orders/:id/cancel  cancel from PENDING or TRIGGERED
 *
 * The controller is passed in rather than imported here, so the API suite can
 * mount these routes over fakes without a database or an RPC endpoint.
 */
export function buildOrderRoutes(controller: OrderController): ExpressRouter {
  const router = Router();

  router.post('/', controller.createOrder);
  router.get('/', controller.listOrders);
  router.get('/:id', controller.getOrder);
  router.post('/:id/cancel', controller.cancelOrder);

  return router;
}
