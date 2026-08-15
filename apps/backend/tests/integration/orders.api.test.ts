import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../../src/app.js';
import { OrderController } from '../../src/api/controllers/order.controller.js';
import { OrderService } from '../../src/services/order.service.js';
import type { OrderRepository } from '@soe/core';
import {
  FakeContractClient,
  FakeOrderRepository,
  USER,
  WETH,
  validOrderInput,
} from '../helpers/fakes.js';

/**
 * Full HTTP surface via supertest, mounted over in-memory fakes — no database
 * and no RPC endpoint. Exercises the real routing, validation, serialisation and
 * error-mapping code paths.
 */
describe('orders API', () => {
  let app: Express;
  let repo: FakeOrderRepository;
  let contract: FakeContractClient;
  let service: OrderService;

  beforeEach(() => {
    repo = new FakeOrderRepository();
    contract = new FakeContractClient();
    service = new OrderService(repo as unknown as OrderRepository, () => contract);
    app = createApp({ orderController: new OrderController(service) });
  });

  describe('POST /api/orders', () => {
    it('creates an order and returns 201', async () => {
      const res = await request(app).post('/api/orders').send(validOrderInput());

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.tokenIn).toBe('ETH');
      expect(res.body.data.executionId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(res.body.data.txHash).toBeNull();
    });

    it('serialises decimals as strings, not numbers', async () => {
      // A JSON number would round-trip 0.01 lossily. Assert the wire type, not
      // just the value.
      const res = await request(app).post('/api/orders').send(validOrderInput());

      expect(typeof res.body.data.amount).toBe('string');
      expect(res.body.data.amount).toBe('0.01');
      expect(typeof res.body.data.triggerPrice).toBe('string');
      expect(res.body.data.triggerPrice).toBe('3500');
    });

    it('does not leak the internal version column', async () => {
      const res = await request(app).post('/api/orders').send(validOrderInput());
      expect(res.body.data.version).toBeUndefined();
    });

    it('rejects a numeric amount with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/orders')
        .send({ ...validOrderInput(), amount: 0.01 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a malformed address with 400', async () => {
      const res = await request(app)
        .post('/api/orders')
        .send(validOrderInput({ userAddress: '0xdead' }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unsupported token with 400 TOKEN_NOT_SUPPORTED', async () => {
      const res = await request(app)
        .post('/api/orders')
        .send(validOrderInput({ tokenIn: 'DOGE' }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TOKEN_NOT_SUPPORTED');
    });

    it('returns 400 TRADE_TOO_LARGE above the on-chain cap', async () => {
      contract.maxTrade.set(WETH, 1n);
      const res = await request(app).post('/api/orders').send(validOrderInput());

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRADE_TOO_LARGE');
    });

    it('returns 503 CONTRACT_PAUSED when the contract is paused', async () => {
      contract.paused = true;
      const res = await request(app).post('/api/orders').send(validOrderInput());

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('CONTRACT_PAUSED');
    });
  });

  describe('GET /api/orders', () => {
    it('lists orders with pagination metadata', async () => {
      await request(app).post('/api/orders').send(validOrderInput());
      await request(app).post('/api/orders').send(validOrderInput());

      const res = await request(app).get('/api/orders');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({ total: 2, limit: 20, offset: 0 });
    });

    it('filters by userAddress', async () => {
      await request(app).post('/api/orders').send(validOrderInput());
      await request(app)
        .post('/api/orders')
        .send(validOrderInput({ userAddress: '0x1111111111111111111111111111111111111111' }));

      const res = await request(app).get('/api/orders').query({ userAddress: USER });

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].userAddress).toBe(USER);
    });

    it('filters by status', async () => {
      await request(app).post('/api/orders').send(validOrderInput());
      const res = await request(app).get('/api/orders').query({ status: 'EXECUTED' });

      expect(res.body.data).toHaveLength(0);
    });

    it('rejects an invalid status filter with 400', async () => {
      const res = await request(app).get('/api/orders').query({ status: 'NOPE' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/orders/:id', () => {
    it('returns the order', async () => {
      const created = await request(app).post('/api/orders').send(validOrderInput());
      const res = await request(app).get(`/api/orders/${created.body.data.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(created.body.data.id);
    });

    it('returns 404 ORDER_NOT_FOUND for an unknown id', async () => {
      const res = await request(app).get('/api/orders/8ad0a1de-0000-4000-8000-000000000000');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('returns 400 for a non-UUID id', async () => {
      const res = await request(app).get('/api/orders/not-a-uuid');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/orders/:id/cancel', () => {
    it('cancels a PENDING order', async () => {
      const created = await request(app).post('/api/orders').send(validOrderInput());
      const res = await request(app).post(`/api/orders/${created.body.data.id}/cancel`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');
    });

    it('returns 409 INVALID_TRANSITION when cancelling twice', async () => {
      const created = await request(app).post('/api/orders').send(validOrderInput());
      await request(app).post(`/api/orders/${created.body.data.id}/cancel`);

      const res = await request(app).post(`/api/orders/${created.body.data.id}/cancel`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
    });

    it('returns 409 when the order is already EXECUTING', async () => {
      const created = await request(app).post('/api/orders').send(validOrderInput());
      const id = created.body.data.id;

      await service.markTriggered(id);
      await service.transition(await service.getOrder(id), 'EXECUTING');

      const res = await request(app).post(`/api/orders/${id}/cancel`);
      expect(res.status).toBe(409);
    });
  });

  describe('unknown routes', () => {
    it('returns a structured 404', async () => {
      const res = await request(app).get('/api/nope');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
