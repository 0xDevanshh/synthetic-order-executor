/**
 * Test environment. Set before any module reads process.env.
 *
 * No Redis and no RPC endpoint: every test drives TriggerEngine directly with
 * in-memory fakes, which is the payoff of keeping BullMQ at the edge.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'fatal';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PRICE_PROVIDER = 'static';
process.env.STATIC_PRICE = '3500';
