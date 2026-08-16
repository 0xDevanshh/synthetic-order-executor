import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@soe/database';

import { TriggerEngine } from '../src/trigger/triggerEngine.js';
import { PriceService } from '@soe/chain';
import { PriceUnavailableError, PriceUntrustedError } from '@soe/chain';
import {
  asRepository,
  FakeOrderRepository,
  FakePipeline,
  FakePriceProvider,
  makeOrder,
  silentLogger,
} from './helpers/fakes.js';

describe('TriggerEngine', () => {
  let repo: FakeOrderRepository;
  let pipeline: FakePipeline;
  let provider: FakePriceProvider;

  const build = (crossCheck?: FakePriceProvider) =>
    new TriggerEngine(
      new PriceService(provider, crossCheck, { maxStalenessSec: 3600, maxDivergenceBps: 200 }),
      asRepository(repo),
      pipeline,
      silentLogger,
    );

  beforeEach(() => {
    repo = new FakeOrderRepository();
    pipeline = new FakePipeline();
    provider = new FakePriceProvider('3500');
  });

  describe('the worked example', () => {
    it('triggers SELL 0.01 ETH @ 3500 when the price is 3490', async () => {
      const order = makeOrder({ side: 'SELL', triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3490');

      const result = await build().run();

      expect(result.triggered).toEqual([order.id]);
      expect(repo.orders.get(order.id)?.status).toBe('TRIGGERED');
    });

    it('leaves the same order PENDING when the price is 3600', async () => {
      const order = makeOrder({ side: 'SELL', triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3600');

      const result = await build().run();

      expect(result.triggered).toEqual([]);
      expect(result.candidates).toBe(0);
      expect(repo.orders.get(order.id)?.status).toBe('PENDING');
    });

    it('triggers at exactly the trigger price', async () => {
      const order = makeOrder({ side: 'SELL', triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3500');

      expect((await build().run()).triggered).toEqual([order.id]);
    });
  });

  describe('handoff to the execution pipeline', () => {
    it('enqueues every triggered order exactly once', async () => {
      const a = makeOrder({ triggerPrice: dec('3500') });
      const b = makeOrder({ triggerPrice: dec('3600') });
      repo.add(a, b);
      provider.set('3400');

      await build().run();

      expect(pipeline.enqueued.sort()).toEqual([a.id, b.id].sort());
    });

    it('never enqueues an order it did not claim', async () => {
      const order = makeOrder({ triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3400');
      repo.stealNext = 1;

      const result = await build().run();

      expect(result.triggered).toEqual([]);
      expect(result.skipped).toBe(1);
      expect(pipeline.enqueued).toEqual([]);
    });

    it('keeps the order TRIGGERED when handoff fails, and reports it', async () => {
      // The condition genuinely was met. Rolling back to PENDING would re-fire
      // the order later at a different price, which is worse than leaving it for
      // the sweep.
      const order = makeOrder({ triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3400');
      pipeline.error = new Error('redis down');

      const result = await build().run();

      expect(result.triggered).toEqual([order.id]);
      expect(result.handoffFailures).toEqual([order.id]);
      expect(repo.orders.get(order.id)?.status).toBe('TRIGGERED');
    });
  });

  describe('duplicate triggering', () => {
    it('does not re-trigger an order that is already TRIGGERED', async () => {
      const order = makeOrder({ status: 'TRIGGERED', triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3400');

      const result = await build().run();

      expect(result.candidates).toBe(0);
      expect(pipeline.enqueued).toEqual([]);
    });

    it('triggers only once across repeated evaluation passes', async () => {
      const order = makeOrder({ triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3400');

      const engine = build();
      await engine.run();
      await engine.run();
      await engine.run();

      expect(pipeline.enqueued).toEqual([order.id]);
    });

    it('lets only one of two concurrent engines claim the same order', async () => {
      // Two watcher instances on the same tick. The (status, version)
      // compare-and-swap is what makes exactly one win.
      const order = makeOrder({ triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3400');

      const pipelineA = new FakePipeline();
      const pipelineB = new FakePipeline();
      const mk = (p: FakePipeline) =>
        new TriggerEngine(new PriceService(provider), asRepository(repo), p, silentLogger);

      await Promise.all([mk(pipelineA).run(), mk(pipelineB).run()]);

      expect(pipelineA.enqueued.length + pipelineB.enqueued.length).toBe(1);
    });

    it('ignores CANCELLED, EXECUTING, EXECUTED and FAILED orders', async () => {
      repo.add(
        makeOrder({ status: 'CANCELLED', triggerPrice: dec('3500') }),
        makeOrder({ status: 'EXECUTING', triggerPrice: dec('3500') }),
        makeOrder({ status: 'EXECUTED', triggerPrice: dec('3500') }),
        makeOrder({ status: 'FAILED', triggerPrice: dec('3500') }),
      );
      provider.set('3400');

      const result = await build().run();

      expect(result.candidates).toBe(0);
      expect(pipeline.enqueued).toEqual([]);
    });
  });

  describe('BUY orders', () => {
    it('fires a BUY when the price rises to the trigger', async () => {
      const order = makeOrder({ side: 'BUY', triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3600');

      expect((await build().run()).triggered).toEqual([order.id]);
    });

    it('does not fire a BUY below its trigger', async () => {
      repo.add(makeOrder({ side: 'BUY', triggerPrice: dec('3500') }));
      provider.set('3400');

      expect((await build().run()).triggered).toEqual([]);
    });

    it('selects only the correct side when both exist at one price', async () => {
      const sell = makeOrder({ side: 'SELL', triggerPrice: dec('3500') });
      const buy = makeOrder({ side: 'BUY', triggerPrice: dec('3500') });
      repo.add(sell, buy);
      provider.set('3400'); // below: SELL fires, BUY does not

      const result = await build().run();

      expect(result.triggered).toEqual([sell.id]);
    });
  });

  describe('price safety', () => {
    it('fires nothing when the price source is unavailable', async () => {
      repo.add(makeOrder({ triggerPrice: dec('3500') }));
      provider.error = new PriceUnavailableError('fake', 'ETH/USD', 'feed down');

      await expect(build().run()).rejects.toThrow(PriceUnavailableError);
      expect(pipeline.enqueued).toEqual([]);
    });

    it('fires nothing when the price is stale', async () => {
      repo.add(makeOrder({ triggerPrice: dec('3500') }));
      provider.set('3400', new Date(Date.now() - 7_200_000)); // 2h old

      await expect(build().run()).rejects.toThrow(PriceUntrustedError);
      expect(pipeline.enqueued).toEqual([]);
    });

    it('fires nothing when two sources diverge beyond tolerance', async () => {
      repo.add(makeOrder({ triggerPrice: dec('3500') }));
      provider.set('3400');
      const crossCheck = new FakePriceProvider('3000'); // ~12% apart

      await expect(build(crossCheck).run()).rejects.toThrow(PriceUntrustedError);
      expect(pipeline.enqueued).toEqual([]);
    });

    it('proceeds when two sources agree within tolerance', async () => {
      const order = makeOrder({ triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3400');
      const crossCheck = new FakePriceProvider('3405'); // ~15bps apart

      expect((await build(crossCheck).run()).triggered).toEqual([order.id]);
    });

    it('proceeds when the cross-check is merely unavailable', async () => {
      // A down cross-check must not halt trading — that would turn an optional
      // safety net into a hard availability dependency.
      const order = makeOrder({ triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3400');

      const crossCheck = new FakePriceProvider('3400');
      crossCheck.error = new PriceUnavailableError('fake2', 'ETH/USD', 'timeout');

      expect((await build(crossCheck).run()).triggered).toEqual([order.id]);
    });
  });

  describe('reporting', () => {
    it('reports the price and source that drove the decision', async () => {
      repo.add(makeOrder({ triggerPrice: dec('3500') }));
      provider.set('3490');

      const result = await build().run();

      expect(result.price).toBe('3490');
      expect(result.source).toBe('fake');
      expect(result.candidates).toBe(1);
    });

    it('never submits a blockchain transaction', async () => {
      // Structural: the engine's only outbound dependency is the pipeline
      // interface. There is no signer here, by construction.
      const order = makeOrder({ triggerPrice: dec('3500') });
      repo.add(order);
      provider.set('3400');

      await build().run();

      expect(pipeline.enqueued).toEqual([order.id]);
      expect(repo.orders.get(order.id)?.txHash).toBeNull();
    });
  });
});

/** Small helper so the cases read as prices rather than Decimal constructions. */
function dec(v: string): Prisma.Decimal {
  return new Prisma.Decimal(v);
}
