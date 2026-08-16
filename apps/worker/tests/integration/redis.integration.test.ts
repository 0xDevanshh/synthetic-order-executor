import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { BullExecutionPipeline, BullMonitorPipeline } from '../../src/queues/queues.js';

/**
 * Integration tests against REAL Redis + BullMQ.
 *
 * The unit suite asserts deduplication against a fake pipeline that just pushes
 * to an array — which proves nothing about BullMQ's actual jobId semantics.
 * That dedup is one of the layers protecting against duplicate execution, so it
 * needs to be verified against the real thing.
 *
 * Requires Redis and TEST_REDIS_URL. Skipped otherwise.
 */
const REDIS_URL = process.env.TEST_REDIS_URL;
const describeIf = REDIS_URL ? describe : describe.skip;

describeIf('Redis + BullMQ integration', () => {
  let connection: IORedis;
  let queue: Queue;

  beforeAll(async () => {
    connection = new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue('test-execute-order', { connection });
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.close();
    await connection.quit();
  });

  describe('execution pipeline deduplication', () => {
    it('collapses repeated enqueues of the same order into ONE job', async () => {
      // jobId = orderId. BullMQ refuses a duplicate id while one is waiting,
      // active or delayed — the queue-level layer of duplicate protection.
      const pipeline = new BullExecutionPipeline(queue);
      const orderId = 'order-dedup-1';

      await pipeline.enqueue(orderId);
      await pipeline.enqueue(orderId);
      await pipeline.enqueue(orderId);

      expect(await queue.getWaitingCount()).toBe(1);
    });

    it('keeps distinct orders as distinct jobs', async () => {
      const pipeline = new BullExecutionPipeline(queue);

      await pipeline.enqueue('order-a');
      await pipeline.enqueue('order-b');
      await pipeline.enqueue('order-c');

      expect(await queue.getWaitingCount()).toBe(3);
    });

    it('survives 10 concurrent enqueues of the same order', async () => {
      // Ten workers reacting to the same tick. Even racing, one job results.
      const pipeline = new BullExecutionPipeline(queue);

      await Promise.all(Array.from({ length: 10 }, () => pipeline.enqueue('order-race')));

      expect(await queue.getWaitingCount()).toBe(1);
    });

    it('carries the orderId through to the job payload', async () => {
      const pipeline = new BullExecutionPipeline(queue);
      await pipeline.enqueue('order-payload');

      const [job] = await queue.getWaiting();
      expect(job?.data).toEqual({ orderId: 'order-payload' });
      expect(job?.id).toBe('order-payload');
    });

    it('configures retries with exponential backoff', async () => {
      const pipeline = new BullExecutionPipeline(queue);
      await pipeline.enqueue('order-opts');

      const [job] = await queue.getWaiting();
      expect(job?.opts.attempts).toBe(3);
      expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
    });
  });

  describe('monitor pipeline', () => {
    it('deduplicates the initial monitor check per order', async () => {
      const monitorQueue = new Queue('test-tx-monitor', { connection });
      try {
        await monitorQueue.obliterate({ force: true });
        const pipeline = new BullMonitorPipeline(monitorQueue);

        await pipeline.enqueue('order-monitor');
        await pipeline.enqueue('order-monitor');

        expect(await monitorQueue.getDelayedCount()).toBe(1);
      } finally {
        await monitorQueue.obliterate({ force: true });
        await monitorQueue.close();
      }
    });
  });

  describe('repeatable schedulers', () => {
    it('does not stack duplicate schedulers across restarts', async () => {
      // A fixed jobId is what keeps a deploy from multiplying the poll rate.
      const repeatQueue = new Queue('test-price-watcher', { connection });
      try {
        await repeatQueue.obliterate({ force: true });

        for (let i = 0; i < 3; i += 1) {
          await repeatQueue.add(
            'evaluate-triggers',
            {},
            { jobId: 'price-watcher-repeatable', repeat: { every: 10_000 } },
          );
        }

        expect(await repeatQueue.getRepeatableJobs()).toHaveLength(1);
      } finally {
        await repeatQueue.obliterate({ force: true });
        await repeatQueue.close();
      }
    });
  });
});
