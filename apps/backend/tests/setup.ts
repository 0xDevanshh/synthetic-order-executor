/**
 * Test environment.
 *
 * Set before any module reads process.env, so the env schema validates against
 * these rather than a developer's real .env. In particular DATABASE_URL is a
 * dummy: the unit suite never opens a connection, because every test injects a
 * fake repository.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'fatal';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.CHAIN_ID = '11155111';
process.env.SEPOLIA_RPC_URL = 'https://sepolia.example.invalid';
process.env.EXECUTOR_CONTRACT_ADDRESS = '0x34C7244383f129957e631706AA420D5CFF721c35';
process.env.WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
process.env.USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
process.env.EXECUTION_SLIPPAGE_BPS = '100';
process.env.DEADLINE_WINDOW_SEC = '120';
process.env.DEFAULT_POOL_FEE = '3000';
