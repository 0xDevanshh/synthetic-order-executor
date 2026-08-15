import type { NextFunction, Request, Response } from 'express';

import { OrderService, orderService } from '../../services/order.service.js';
import {
  createOrderSchema,
  listOrdersQuerySchema,
  orderIdParamSchema,
} from '../schemas/order.schema.js';
import { serializeOrder } from '../serializers/order.serializer.js';
import { ValidationError } from '../../domain/errors.js';

/**
 * HTTP adapter for order use-cases.
 *
 * Parses and validates input, delegates to the service, serialises the result.
 * It contains no business rules and — per the layering requirement — no contract
 * interaction whatsoever: the controller cannot reach viem or the ABI even by
 * accident, because it does not import them.
 */
export class OrderController {
  constructor(private readonly service: OrderService = orderService) {}

  createOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid order payload', parsed.error.flatten());
      }

      const order = await this.service.createOrder(parsed.data);
      res.status(201).json({ data: serializeOrder(order) });
    } catch (error) {
      next(error);
    }
  };

  listOrders = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = listOrdersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('Invalid query parameters', parsed.error.flatten());
      }

      const result = await this.service.listOrders(parsed.data);
      res.json({
        data: result.orders.map(serializeOrder),
        pagination: {
          total: result.total,
          limit: result.limit,
          offset: result.offset,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = orderIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new ValidationError('Invalid order id', parsed.error.flatten());
      }

      const order = await this.service.getOrder(parsed.data.id);
      res.json({ data: serializeOrder(order) });
    } catch (error) {
      next(error);
    }
  };

  cancelOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = orderIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new ValidationError('Invalid order id', parsed.error.flatten());
      }

      const order = await this.service.cancelOrder(parsed.data.id);
      res.json({ data: serializeOrder(order) });
    } catch (error) {
      next(error);
    }
  };
}

export const orderController = new OrderController();
