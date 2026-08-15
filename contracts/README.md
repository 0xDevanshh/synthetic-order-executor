# Contracts

`SyntheticOrderExecutor.sol` — the restricted on-chain execution layer for
synthetic orders. Target: **Ethereum Sepolia, chain id 11155111**. Toolchain:
Hardhat + viem + OpenZeppelin v5.

## What this contract is, and is not

It does **not** decide when an order executes. It holds no trigger prices, no
oracle reads, no order book. The backend watches the price and decides WHEN.

It decides **how** a trade is permitted to happen:

| Guarantee | Mechanism |
|---|---|
| Only an authorized executor submits | `EXECUTOR_ROLE` (OZ `AccessControl`) |
| Only allowlisted tokens trade | `allowedToken` mapping |
| Bounded trade size | `maxTradeAmount[token]`, per token |
| Slippage floor | `amountOutMinimum` to the router **and** a post-swap `amountOut >= minAmountOut` check |
| Deadline | `block.timestamp > deadline` reverts |
| Never executes twice | `executedIds[executionId]`, set *before* the swap |
| Emergency stop | `Pausable`; `withdraw` deliberately still works while paused |
| No unrestricted withdrawals | Withdrawals are `msg.sender`-scoped; the only admin token movement is bounded to the unaccounted surplus |
| Reentrancy | `ReentrancyGuard` + strict checks-effects-interactions |

## Execution entry point

```solidity
function executeSwap(
    bytes32 executionId,
    address owner,
    address tokenIn,
    address tokenOut,
    uint24  poolFee,
    uint256 amountIn,
    uint256 minAmountOut,
    uint256 deadline
) external onlyRole(EXECUTOR_ROLE) whenNotPaused nonReentrant returns (uint256 amountOut);
```

Two parameters extend the shape in the brief, both forced by other requirements:

- **`owner`** — funds are attributable per user. Without it there is no way to
  debit a specific user and credit them back, and the "no unrestricted movement
  of user funds" requirement could not be met.
- **`poolFee`** — Uniswap V3 pools are per-fee-tier. There is no single
  canonical WETH/USDC pool, so the tier chosen off-chain must be passed in.

## Custody model

A per-user vault, not an allowance spender. Users `deposit`; the contract tracks
`balances[user][token]`. A swap debits the owner's balance and credits the
proceeds back to that same owner. Only the owner can withdraw their own balance.

Consequences worth stating explicitly:

- There is no `withdraw(token, recipient, amount)` admin function anywhere in
  this contract. A test asserts structurally that the ABI contains no such
  entry point, so adding one later fails the suite.
- `withdraw` is **not** `whenNotPaused`. A pause stops trading; it must never
  trap funds.
- `withdraw` is **not** restricted to allowlisted tokens. De-allowlisting a
  token must not strand balances held in it.

### The one admin token movement

```solidity
function sweepUnaccounted(address token, address to) external onlyRole(DEFAULT_ADMIN_ROLE);
```

Bounded by arithmetic, not by policy: it can move at most
`balanceOf(this) - totalAccounted[token]`. Since `totalAccounted` is the exact
sum of every user balance, maintained on every deposit, withdrawal and swap, the
sweepable amount is by construction the portion no user has a claim to. There is
no input that makes it touch a deposit. It exists because tokens sent directly
to the contract (bypassing `deposit`) would otherwise be permanently stuck.

## Layout

```
src/
  SyntheticOrderExecutor.sol   main contract
  interfaces/                  ISwapRouter02, IQuoterV2, IWETH9
  mocks/                       MockERC20, MockWETH9, MockSwapRouter,
                               LyingSwapRouter, ReentrantToken
test/                          unit suite (59 tests) + fork suite
script/                        deploy, configure, verify, seedPool, exportAbi
```

## Commands

```bash
npx hardhat compile
npx hardhat test                 # 59 unit tests, no RPC needed
FORK=1 npx hardhat test test/SyntheticOrderExecutor.fork.test.ts
npx hardhat run script/deploy.ts --network sepolia
```

## Uniswap on Sepolia

Verified against the official Uniswap deployments documentation:

| Contract | Address |
|---|---|
| SwapRouter02 | `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E` |
| QuoterV2 | `0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3` |
| UniswapV3Factory | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| NonfungiblePositionManager | `0x1238536071E1c677A632429e3655c799b22cDA52` |
| WETH9 | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |

Two details that trip people up, both confirmed against the
`swap-router-contracts` source:

- **`SwapRouter02.exactInputSingle` has no `deadline` field.** That was the
  legacy `SwapRouter`. `IV3SwapRouter.ExactInputSingleParams` is
  `(tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum,
  sqrtPriceLimitX96)`. This is exactly why `executeSwap` enforces the deadline
  itself against `block.timestamp` — delegating it to the router would silently
  enforce nothing.
- **`QuoterV2` is state-mutating**, so it must be called off-chain with
  `eth_call` / `simulateContract`, never `readContract`. The contract never
  quotes on-chain during execution: deriving a slippage bound from live spot
  price inside the same transaction would let a manipulated pool define its own
  bound.

## Build note

`viaIR: true` is enabled. `executeSwap` takes 8 parameters plus locals, which
overflows the stack under the legacy codegen. The alternative was to force
callers through a params struct; keeping the flat signature was judged the
better trade.
