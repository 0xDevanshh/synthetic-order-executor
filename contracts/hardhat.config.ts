import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox-viem';
import 'dotenv/config';

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? '';
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? '';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? '';

/** Ethereum Sepolia. The only network this project targets. */
export const SEPOLIA_CHAIN_ID = 11155111;

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // executeSwap takes 8 parameters plus locals, which overflows the stack
      // under the legacy codegen. viaIR resolves it and keeps the flat,
      // readable signature rather than forcing callers through a params struct.
      viaIR: true,
      evmVersion: 'paris',
    },
  },
  paths: {
    sources: './src',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Fork Sepolia for integration tests against the real Uniswap router.
      // Enable by exporting SEPOLIA_RPC_URL and FORK=1.
      forking: process.env.FORK === '1' && SEPOLIA_RPC_URL
        ? { url: SEPOLIA_RPC_URL }
        : undefined,
    },
    localhost: {
      url: 'http://127.0.0.1:8545',
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: SEPOLIA_CHAIN_ID,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: { sepolia: ETHERSCAN_API_KEY },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === '1',
    currency: 'USD',
  },
};

export default config;
