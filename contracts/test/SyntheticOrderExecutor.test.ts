import { expect } from 'chai';
import hre from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { parseUnits, zeroAddress, getAddress } from 'viem';

import {
  deployExecutorFixture,
  executionId,
  expectRevert,
  futureDeadline,
  MAX_TRADE_WETH,
  ONE_WETH,
  POOL_FEE,
} from './helpers/fixtures';

/**
 * The suite is organised by the guarantee each group defends rather than by
 * function, because the guarantees are what a reviewer needs to audit.
 */
describe('SyntheticOrderExecutor', () => {
  const HALF_WETH = parseUnits('0.5', 18);
  const QUOTED_OUT = parseUnits('1750', 6);
  const MIN_OUT = parseUnits('1700', 6);

  // ---------------------------------------------------------------------------
  // 1. Authorized executor succeeds
  // ---------------------------------------------------------------------------
  describe('authorized execution', () => {
    it('lets the authorized executor execute a swap', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([QUOTED_OUT]);

      await soe.write.executeSwap(
        [
          executionId('exec-1'),
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          HALF_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      expect(await soe.read.balances([user.account.address, tokenIn.address])).to.equal(
        ONE_WETH - HALF_WETH,
      );
      expect(await soe.read.balances([user.account.address, tokenOut.address])).to.equal(
        QUOTED_OUT,
      );
    });

    it('records the execution id so reconciliation can probe it', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      const id = executionId('exec-probe');
      expect(await soe.read.isExecuted([id])).to.equal(false);

      await router.write.setNextAmountOut([QUOTED_OUT]);
      await soe.write.executeSwap(
        [
          id,
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          HALF_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      expect(await soe.read.isExecuted([id])).to.equal(true);
    });

    it('keeps totalAccounted consistent with the contract token balances', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([QUOTED_OUT]);
      await soe.write.executeSwap(
        [
          executionId('exec-accounting'),
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          HALF_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      // The invariant that makes sweepUnaccounted safe.
      expect(await soe.read.totalAccounted([tokenIn.address])).to.equal(
        await tokenIn.read.balanceOf([soe.address]),
      );
      expect(await soe.read.totalAccounted([tokenOut.address])).to.equal(
        await tokenOut.read.balanceOf([soe.address]),
      );
    });

    it('grants the router a scoped approval and clears it afterwards', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([QUOTED_OUT]);
      await soe.write.executeSwap(
        [
          executionId('exec-approval'),
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          HALF_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      // Exactly amountIn was approved, never an infinite allowance...
      expect(await router.read.observedAllowance()).to.equal(HALF_WETH);
      // ...and nothing is left standing after the call.
      expect(await tokenIn.read.allowance([soe.address, router.address])).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Unauthorized executor fails
  // ---------------------------------------------------------------------------
  describe('unauthorized execution', () => {
    it('rejects a caller without EXECUTOR_ROLE', async () => {
      const { soe, router, tokenIn, tokenOut, other, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-unauth'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: other.account },
        ),
        'AccessControlUnauthorizedAccount',
      );
    });

    it('rejects the admin — holding DEFAULT_ADMIN_ROLE does not confer execution rights', async () => {
      const { soe, router, tokenIn, tokenOut, admin, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-admin'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: admin.account },
        ),
        'AccessControlUnauthorizedAccount',
      );
    });

    it('rejects the previous executor after rotation', async () => {
      const { soe, router, tokenIn, tokenOut, admin, executor, other, user } =
        await loadFixture(deployExecutorFixture);

      await soe.write.setExecutor([other.account.address], { account: admin.account });
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-rotated'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'AccessControlUnauthorizedAccount',
      );

      // And the new executor works.
      await soe.write.executeSwap(
        [
          executionId('exec-new'),
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          HALF_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: other.account },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Non-allowed token fails
  // ---------------------------------------------------------------------------
  describe('token allowlist', () => {
    it('rejects a non-allowlisted tokenIn', async () => {
      const { soe, router, tokenOut, executor, user } = await loadFixture(deployExecutorFixture);

      const rogue = await hre.viem.deployContract('MockERC20', ['Rogue', 'RGE', 18]);
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-badin'),
            user.account.address,
            rogue.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'TokenNotAllowed',
      );
    });

    it('rejects a non-allowlisted tokenOut', async () => {
      const { soe, router, tokenIn, executor, user } = await loadFixture(deployExecutorFixture);

      const rogue = await hre.viem.deployContract('MockERC20', ['Rogue', 'RGE', 18]);
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-badout'),
            user.account.address,
            tokenIn.address,
            rogue.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'TokenNotAllowed',
      );
    });

    it('rejects a token after it is removed from the allowlist', async () => {
      const { soe, router, tokenIn, tokenOut, admin, executor, user } =
        await loadFixture(deployExecutorFixture);

      await soe.write.removeToken([tokenIn.address], { account: admin.account });
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-removed'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'TokenNotAllowed',
      );
    });

    it('rejects tokenIn == tokenOut', async () => {
      const { soe, tokenIn, executor, user } = await loadFixture(deployExecutorFixture);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-same'),
            user.account.address,
            tokenIn.address,
            tokenIn.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'IdenticalTokens',
      );
    });

    it('rejects deposits of a non-allowlisted token', async () => {
      const { soe, user } = await loadFixture(deployExecutorFixture);

      const rogue = await hre.viem.deployContract('MockERC20', ['Rogue', 'RGE', 18]);
      await rogue.write.mint([user.account.address, ONE_WETH]);
      await rogue.write.approve([soe.address, ONE_WETH], { account: user.account });

      await expectRevert(
        soe.write.deposit([rogue.address, ONE_WETH], { account: user.account }),
        'TokenNotAllowed',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Trade above maximum fails
  // ---------------------------------------------------------------------------
  describe('maximum trade size', () => {
    it('rejects amountIn above maxTradeAmount', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      // Give the user enough balance that the cap, not the balance, is what bites.
      await tokenIn.write.approve([soe.address, parseUnits('5', 18)], { account: user.account });
      await soe.write.deposit([tokenIn.address, parseUnits('5', 18)], { account: user.account });

      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-toobig'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            MAX_TRADE_WETH + 1n,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'TradeTooLarge',
      );
    });

    it('accepts amountIn exactly at the cap', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([QUOTED_OUT]);

      await soe.write.executeSwap(
        [
          executionId('exec-atcap'),
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          MAX_TRADE_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      expect(await soe.read.balances([user.account.address, tokenIn.address])).to.equal(0n);
    });

    it('honours an updated cap', async () => {
      const { soe, router, tokenIn, tokenOut, admin, executor, user } =
        await loadFixture(deployExecutorFixture);

      await soe.write.setMaxTradeAmount([tokenIn.address, parseUnits('0.1', 18)], {
        account: admin.account,
      });
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-newcap'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            parseUnits('0.2', 18),
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'TradeTooLarge',
      );
    });

    it('rejects a trade exceeding the owner vault balance', async () => {
      const { soe, router, tokenIn, tokenOut, executor, other } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([QUOTED_OUT]);

      // `other` never deposited — the executor cannot conjure a balance.
      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-nobalance'),
            other.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'InsufficientBalance',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Expired deadline fails
  // ---------------------------------------------------------------------------
  describe('deadline', () => {
    it('rejects an expired deadline', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-expired'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(-3600),
          ],
          { account: executor.account },
        ),
        'DeadlineExpired',
      );
    });

    it('does not consume the execution id when the deadline check fails', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      const id = executionId('exec-retry-after-expiry');
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            id,
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(-1),
          ],
          { account: executor.account },
        ),
        'DeadlineExpired',
      );

      // A reverted transaction rolls back every state change, so the id stays
      // reusable. The backend can safely resubmit with a fresh deadline.
      expect(await soe.read.isExecuted([id])).to.equal(false);

      await soe.write.executeSwap(
        [
          id,
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          HALF_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: executor.account },
      );
      expect(await soe.read.isExecuted([id])).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Slippage protection works
  // ---------------------------------------------------------------------------
  describe('slippage protection', () => {
    it('reverts when the router would deliver less than minAmountOut', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      // Router will pay 1699 USDC against a 1700 USDC floor.
      await router.write.setNextAmountOut([MIN_OUT - parseUnits('1', 6)]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-slippage'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'MockRouterTooLittleReceived',
      );
    });

    it('leaves balances untouched when a swap reverts on slippage', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([MIN_OUT - 1n]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-slippage-state'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'MockRouterTooLittleReceived',
      );

      expect(await soe.read.balances([user.account.address, tokenIn.address])).to.equal(ONE_WETH);
      expect(await soe.read.balances([user.account.address, tokenOut.address])).to.equal(0n);
    });

    it('accepts an output exactly equal to minAmountOut', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([MIN_OUT]);

      await soe.write.executeSwap(
        [
          executionId('exec-exact'),
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          HALF_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      expect(await soe.read.balances([user.account.address, tokenOut.address])).to.equal(MIN_OUT);
    });

    it('enforces its own SlippageExceeded guard, not just the router check', async () => {
      // The contract re-checks amountOut >= minAmountOut after the swap rather
      // than trusting the router's enforcement. This proves the guard exists by
      // pointing the executor at a router that ignores amountOutMinimum.
      const { admin, executor, user, tokenIn, tokenOut, weth } =
        await loadFixture(deployExecutorFixture);

      const lyingRouter = await hre.viem.deployContract('LyingSwapRouter', []);
      const soe2 = await hre.viem.deployContract('SyntheticOrderExecutor', [
        lyingRouter.address,
        weth.address,
        admin.account.address,
        executor.account.address,
      ]);

      await soe2.write.setTokenAllowed([tokenIn.address, MAX_TRADE_WETH], {
        account: admin.account,
      });
      await soe2.write.setTokenAllowed([tokenOut.address, parseUnits('5000', 6)], {
        account: admin.account,
      });

      await tokenOut.write.mint([lyingRouter.address, parseUnits('100000', 6)]);
      await tokenIn.write.mint([user.account.address, ONE_WETH]);
      await tokenIn.write.approve([soe2.address, ONE_WETH], { account: user.account });
      await soe2.write.deposit([tokenIn.address, ONE_WETH], { account: user.account });

      await lyingRouter.write.setNextAmountOut([MIN_OUT - 1n]);

      await expectRevert(
        soe2.write.executeSwap(
          [
            executionId('exec-lying-router'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'SlippageExceeded',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Paused contract rejects execution
  // ---------------------------------------------------------------------------
  describe('pause', () => {
    it('rejects execution while paused', async () => {
      const { soe, router, tokenIn, tokenOut, admin, executor, user } =
        await loadFixture(deployExecutorFixture);

      await soe.write.pause({ account: admin.account });
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-paused'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'EnforcedPause',
      );
    });

    it('rejects deposits while paused', async () => {
      const { soe, tokenIn, admin, user } = await loadFixture(deployExecutorFixture);

      await soe.write.pause({ account: admin.account });
      await tokenIn.write.approve([soe.address, ONE_WETH], { account: user.account });

      await expectRevert(
        soe.write.deposit([tokenIn.address, ONE_WETH], { account: user.account }),
        'EnforcedPause',
      );
    });

    it('STILL ALLOWS withdrawals while paused — a pause must never trap funds', async () => {
      const { soe, tokenIn, admin, user } = await loadFixture(deployExecutorFixture);

      await soe.write.pause({ account: admin.account });
      await soe.write.withdraw([tokenIn.address, ONE_WETH], { account: user.account });

      expect(await soe.read.balances([user.account.address, tokenIn.address])).to.equal(0n);
      expect(await tokenIn.read.balanceOf([user.account.address])).to.equal(parseUnits('10', 18));
    });

    it('resumes execution after unpause', async () => {
      const { soe, router, tokenIn, tokenOut, admin, executor, user } =
        await loadFixture(deployExecutorFixture);

      await soe.write.pause({ account: admin.account });
      await soe.write.unpause({ account: admin.account });
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await soe.write.executeSwap(
        [
          executionId('exec-unpaused'),
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          HALF_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      expect(await soe.read.balances([user.account.address, tokenOut.address])).to.equal(
        QUOTED_OUT,
      );
    });

    it('only PAUSER_ROLE can pause', async () => {
      const { soe, other } = await loadFixture(deployExecutorFixture);
      await expectRevert(
        soe.write.pause({ account: other.account }),
        'AccessControlUnauthorizedAccount',
      );
    });

    it('only admin can unpause, even for a pauser', async () => {
      const { soe, admin, other } = await loadFixture(deployExecutorFixture);

      const pauserRole = await soe.read.PAUSER_ROLE();
      await soe.write.grantRole([pauserRole, other.account.address], { account: admin.account });
      await soe.write.pause({ account: other.account });

      // Pausing is cheap, resuming is deliberate.
      await expectRevert(
        soe.write.unpause({ account: other.account }),
        'AccessControlUnauthorizedAccount',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Duplicate executionId fails
  // ---------------------------------------------------------------------------
  describe('execution id replay protection', () => {
    it('rejects the same executionId twice', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      const id = executionId('exec-dup');
      await router.write.setNextAmountOut([parseUnits('100', 6)]);

      await soe.write.executeSwap(
        [
          id,
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          parseUnits('0.1', 18),
          0n,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      await expectRevert(
        soe.write.executeSwap(
          [
            id,
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            parseUnits('0.1', 18),
            0n,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'ExecutionAlreadyProcessed',
      );
    });

    it('rejects a replay even with entirely different parameters', async () => {
      // The id alone is the key — an attacker cannot reuse it by varying the
      // amounts or the token pair.
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      const id = executionId('exec-dup-params');
      await router.write.setNextAmountOut([parseUnits('100', 6)]);

      await soe.write.executeSwap(
        [
          id,
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          parseUnits('0.1', 18),
          0n,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      await expectRevert(
        soe.write.executeSwap(
          [
            id,
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            500,
            parseUnits('0.2', 18),
            0n,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'ExecutionAlreadyProcessed',
      );
    });

    it('allows distinct execution ids', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      await router.write.setNextAmountOut([parseUnits('100', 6)]);

      for (const label of ['exec-a', 'exec-b', 'exec-c']) {
        await soe.write.executeSwap(
          [
            executionId(label),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            parseUnits('0.1', 18),
            0n,
            await futureDeadline(),
          ],
          { account: executor.account },
        );
      }

      expect(await soe.read.balances([user.account.address, tokenOut.address])).to.equal(
        parseUnits('300', 6),
      );
    });

    it('rejects a zero execution id', async () => {
      const { soe, tokenIn, tokenOut, executor, user } = await loadFixture(deployExecutorFixture);

      await expectRevert(
        soe.write.executeSwap(
          [
            `0x${'0'.repeat(64)}`,
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'InvalidExecutionId',
      );
    });

    it('blocks a reentrant second execution from a malicious token', async () => {
      // Proves the guard holds even when tokenIn itself calls back in.
      const { soe, router, tokenOut, admin, executor, user } =
        await loadFixture(deployExecutorFixture);

      const evil = await hre.viem.deployContract('ReentrantToken', []);
      await soe.write.setTokenAllowed([evil.address, ONE_WETH], { account: admin.account });
      await evil.write.mint([user.account.address, ONE_WETH]);
      await evil.write.approve([soe.address, ONE_WETH], { account: user.account });
      await soe.write.deposit([evil.address, ONE_WETH], { account: user.account });

      await router.write.setNextAmountOut([parseUnits('100', 6)]);

      const reentrantCall = {
        abi: soe.abi,
        functionName: 'executeSwap',
        args: [
          executionId('exec-reenter-inner'),
          user.account.address,
          evil.address,
          tokenOut.address,
          POOL_FEE,
          parseUnits('0.1', 18),
          0n,
          await futureDeadline(),
        ],
      } as const;

      const { encodeFunctionData } = await import('viem');
      await evil.write.arm([soe.address, encodeFunctionData(reentrantCall)]);

      await soe.write.executeSwap(
        [
          executionId('exec-reenter-outer'),
          user.account.address,
          evil.address,
          tokenOut.address,
          POOL_FEE,
          parseUnits('0.1', 18),
          0n,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      expect(await evil.read.attackAttempted()).to.equal(true);
      // ReentrancyGuard rejected the nested call.
      expect(await evil.read.attackSucceeded()).to.equal(false);
      expect(await soe.read.isExecuted([executionId('exec-reenter-inner')])).to.equal(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Correct events are emitted
  // ---------------------------------------------------------------------------
  describe('events', () => {
    it('emits SwapExecuted with the full execution record', async () => {
      const { soe, router, tokenIn, tokenOut, executor, user } =
        await loadFixture(deployExecutorFixture);

      const id = executionId('exec-event');
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await soe.write.executeSwap(
        [
          id,
          user.account.address,
          tokenIn.address,
          tokenOut.address,
          POOL_FEE,
          HALF_WETH,
          MIN_OUT,
          await futureDeadline(),
        ],
        { account: executor.account },
      );

      const events = await soe.getEvents.SwapExecuted();
      expect(events).to.have.lengthOf(1);

      const { args } = events[0];
      expect(args.executionId).to.equal(id);
      expect(getAddress(args.owner!)).to.equal(getAddress(user.account.address));
      expect(getAddress(args.executorAddress!)).to.equal(getAddress(executor.account.address));
      expect(getAddress(args.tokenIn!)).to.equal(getAddress(tokenIn.address));
      expect(getAddress(args.tokenOut!)).to.equal(getAddress(tokenOut.address));
      expect(args.amountIn).to.equal(HALF_WETH);
      // The ACTUAL amount out, which is what reconciliation depends on.
      expect(args.amountOut).to.equal(QUOTED_OUT);
      expect(args.minAmountOut).to.equal(MIN_OUT);
      expect(args.poolFee).to.equal(POOL_FEE);
    });

    it('emits ExecutorUpdated on rotation', async () => {
      const { soe, admin, executor, other } = await loadFixture(deployExecutorFixture);

      await soe.write.setExecutor([other.account.address], { account: admin.account });

      const events = await soe.getEvents.ExecutorUpdated();
      expect(events).to.have.lengthOf(1);
      expect(getAddress(events[0].args.previousExecutor!)).to.equal(
        getAddress(executor.account.address),
      );
      expect(getAddress(events[0].args.newExecutor!)).to.equal(getAddress(other.account.address));
    });

    it('emits TokenAllowed with the configured cap', async () => {
      const { soe, admin } = await loadFixture(deployExecutorFixture);

      const token = await hre.viem.deployContract('MockERC20', ['New', 'NEW', 18]);
      await soe.write.setTokenAllowed([token.address, ONE_WETH], { account: admin.account });

      const events = await soe.getEvents.TokenAllowed();
      expect(events).to.have.lengthOf(1);
      expect(getAddress(events[0].args.token!)).to.equal(getAddress(token.address));
      expect(events[0].args.maxTradeAmount).to.equal(ONE_WETH);
    });

    it('emits TokenRemoved', async () => {
      const { soe, tokenIn, admin } = await loadFixture(deployExecutorFixture);

      await soe.write.removeToken([tokenIn.address], { account: admin.account });

      const events = await soe.getEvents.TokenRemoved();
      expect(events).to.have.lengthOf(1);
      expect(getAddress(events[0].args.token!)).to.equal(getAddress(tokenIn.address));
    });

    it('emits MaxTradeAmountUpdated with both the old and new cap', async () => {
      const { soe, tokenIn, admin } = await loadFixture(deployExecutorFixture);

      const newCap = parseUnits('2', 18);
      await soe.write.setMaxTradeAmount([tokenIn.address, newCap], { account: admin.account });

      const events = await soe.getEvents.MaxTradeAmountUpdated();
      expect(events).to.have.lengthOf(1);
      expect(events[0].args.previousAmount).to.equal(MAX_TRADE_WETH);
      expect(events[0].args.newAmount).to.equal(newCap);
    });

    it('emits Paused and Unpaused', async () => {
      const { soe, admin } = await loadFixture(deployExecutorFixture);

      await soe.write.pause({ account: admin.account });
      expect(await soe.getEvents.Paused()).to.have.lengthOf(1);

      await soe.write.unpause({ account: admin.account });
      expect(await soe.getEvents.Unpaused()).to.have.lengthOf(1);
    });

    it('emits Deposited and Withdrawn', async () => {
      const { soe, tokenIn, user } = await loadFixture(deployExecutorFixture);

      await soe.write.withdraw([tokenIn.address, ONE_WETH], { account: user.account });
      const events = await soe.getEvents.Withdrawn();
      expect(events).to.have.lengthOf(1);
      expect(events[0].args.amount).to.equal(ONE_WETH);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Admin-only functions reject unauthorized callers
  // ---------------------------------------------------------------------------
  describe('admin access control', () => {
    it('rejects setTokenAllowed from a non-admin', async () => {
      const { soe, tokenIn, other } = await loadFixture(deployExecutorFixture);
      await expectRevert(
        soe.write.setTokenAllowed([tokenIn.address, ONE_WETH], { account: other.account }),
        'AccessControlUnauthorizedAccount',
      );
    });

    it('rejects removeToken from a non-admin', async () => {
      const { soe, tokenIn, other } = await loadFixture(deployExecutorFixture);
      await expectRevert(
        soe.write.removeToken([tokenIn.address], { account: other.account }),
        'AccessControlUnauthorizedAccount',
      );
    });

    it('rejects setMaxTradeAmount from a non-admin', async () => {
      const { soe, tokenIn, other } = await loadFixture(deployExecutorFixture);
      await expectRevert(
        soe.write.setMaxTradeAmount([tokenIn.address, ONE_WETH], { account: other.account }),
        'AccessControlUnauthorizedAccount',
      );
    });

    it('rejects setExecutor from a non-admin', async () => {
      const { soe, other } = await loadFixture(deployExecutorFixture);
      await expectRevert(
        soe.write.setExecutor([other.account.address], { account: other.account }),
        'AccessControlUnauthorizedAccount',
      );
    });

    it('rejects setExecutor from the current executor — it cannot rotate itself', async () => {
      const { soe, executor, other } = await loadFixture(deployExecutorFixture);
      await expectRevert(
        soe.write.setExecutor([other.account.address], { account: executor.account }),
        'AccessControlUnauthorizedAccount',
      );
    });

    it('rejects sweepUnaccounted from a non-admin', async () => {
      const { soe, tokenIn, other } = await loadFixture(deployExecutorFixture);
      await expectRevert(
        soe.write.sweepUnaccounted([tokenIn.address, other.account.address], {
          account: other.account,
        }),
        'AccessControlUnauthorizedAccount',
      );
    });

    it('rejects allowlisting the zero address or a zero cap', async () => {
      const { soe, tokenIn, admin } = await loadFixture(deployExecutorFixture);

      await expectRevert(
        soe.write.setTokenAllowed([zeroAddress, ONE_WETH], { account: admin.account }),
        'ZeroAddress',
      );
      await expectRevert(
        soe.write.setTokenAllowed([tokenIn.address, 0n], { account: admin.account }),
        'ZeroAmount',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Fund safety — requirement 10, no arbitrary withdrawal
  // ---------------------------------------------------------------------------
  describe('fund safety', () => {
    it('exposes no admin function capable of moving a user balance', async () => {
      // Structural assertion: the ABI contains no generic withdraw-to-recipient
      // entry point. If someone later adds one, this test fails loudly.
      const { soe } = await loadFixture(deployExecutorFixture);

      const withdrawLike = soe.abi.filter(
        (item) =>
          item.type === 'function' &&
          /withdraw|transfer|rescue|sweep/i.test(item.name) &&
          item.name !== 'withdraw' &&
          item.name !== 'withdrawETH' &&
          item.name !== 'sweepUnaccounted',
      );
      expect(withdrawLike, 'unexpected fund-movement function in ABI').to.have.lengthOf(0);
    });

    it('lets a user withdraw only their own balance', async () => {
      const { soe, tokenIn, other } = await loadFixture(deployExecutorFixture);

      await expectRevert(
        soe.write.withdraw([tokenIn.address, ONE_WETH], { account: other.account }),
        'InsufficientBalance',
      );
    });

    it('allows withdrawal of a de-allowlisted token — removal must not strand funds', async () => {
      const { soe, tokenIn, admin, user } = await loadFixture(deployExecutorFixture);

      await soe.write.removeToken([tokenIn.address], { account: admin.account });
      await soe.write.withdraw([tokenIn.address, ONE_WETH], { account: user.account });

      expect(await soe.read.balances([user.account.address, tokenIn.address])).to.equal(0n);
    });

    it('sweepUnaccounted moves only the surplus above totalAccounted', async () => {
      const { soe, tokenIn, admin, recipient, other } = await loadFixture(deployExecutorFixture);

      // Someone transfers tokens in directly, bypassing deposit().
      await tokenIn.write.mint([other.account.address, parseUnits('3', 18)]);
      await tokenIn.write.transfer([soe.address, parseUnits('3', 18)], { account: other.account });

      expect(await soe.read.unaccountedBalance([tokenIn.address])).to.equal(parseUnits('3', 18));

      await soe.write.sweepUnaccounted([tokenIn.address, recipient.account.address], {
        account: admin.account,
      });

      // Exactly the surplus moved...
      expect(await tokenIn.read.balanceOf([recipient.account.address])).to.equal(
        parseUnits('3', 18),
      );
      // ...and the user's deposit is untouched and still fully backed.
      expect(await soe.read.totalAccounted([tokenIn.address])).to.equal(ONE_WETH);
      expect(await tokenIn.read.balanceOf([soe.address])).to.equal(ONE_WETH);
    });

    it('sweepUnaccounted reverts when everything is accounted for', async () => {
      const { soe, tokenIn, admin, recipient } = await loadFixture(deployExecutorFixture);

      await expectRevert(
        soe.write.sweepUnaccounted([tokenIn.address, recipient.account.address], {
          account: admin.account,
        }),
        'NothingToSweep',
      );
    });

    it('rejects direct ETH transfers', async () => {
      const { soe, user } = await loadFixture(deployExecutorFixture);

      await expectRevert(
        user.sendTransaction({ to: soe.address, value: parseUnits('1', 18) }),
        'DirectEthNotAccepted',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // ETH convenience path
  // ---------------------------------------------------------------------------
  describe('ETH deposit and withdrawal', () => {
    it('wraps ETH on deposit and unwraps on withdrawal', async () => {
      const { soe, weth, user } = await loadFixture(deployExecutorFixture);

      const amount = parseUnits('2', 18);
      await soe.write.depositETH({ account: user.account, value: amount });

      expect(await soe.read.balances([user.account.address, weth.address])).to.equal(amount);
      expect(await weth.read.balanceOf([soe.address])).to.equal(amount);

      await soe.write.withdrawETH([amount], { account: user.account });

      expect(await soe.read.balances([user.account.address, weth.address])).to.equal(0n);
      expect(await weth.read.balanceOf([soe.address])).to.equal(0n);
    });

    it('rejects a zero-value ETH deposit', async () => {
      const { soe, user } = await loadFixture(deployExecutorFixture);
      await expectRevert(
        soe.write.depositETH({ account: user.account, value: 0n }),
        'ZeroAmount',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Deployment configuration
  // ---------------------------------------------------------------------------
  describe('deployment', () => {
    it('grants admin and pauser to the admin, and executor to the executor only', async () => {
      const { soe, admin, executor } = await loadFixture(deployExecutorFixture);

      const adminRole = await soe.read.DEFAULT_ADMIN_ROLE();
      const executorRole = await soe.read.EXECUTOR_ROLE();
      const pauserRole = await soe.read.PAUSER_ROLE();

      expect(await soe.read.hasRole([adminRole, admin.account.address])).to.equal(true);
      expect(await soe.read.hasRole([pauserRole, admin.account.address])).to.equal(true);
      expect(await soe.read.hasRole([executorRole, executor.account.address])).to.equal(true);

      // The admin must NOT be able to execute — that separation is the point.
      expect(await soe.read.hasRole([executorRole, admin.account.address])).to.equal(false);
    });

    it('supports deploying with no executor, so the deployer never holds execution rights', async () => {
      const { admin, weth, router } = await loadFixture(deployExecutorFixture);

      const soe2 = await hre.viem.deployContract('SyntheticOrderExecutor', [
        router.address,
        weth.address,
        admin.account.address,
        zeroAddress,
      ]);

      expect(await soe2.read.executor()).to.equal(zeroAddress);
    });

    it('rejects a zero router, weth or admin', async () => {
      const { admin, weth, router } = await loadFixture(deployExecutorFixture);

      await expectRevert(
        hre.viem.deployContract('SyntheticOrderExecutor', [
          zeroAddress,
          weth.address,
          admin.account.address,
          zeroAddress,
        ]),
        'ZeroAddress',
      );
      await expectRevert(
        hre.viem.deployContract('SyntheticOrderExecutor', [
          router.address,
          weth.address,
          zeroAddress,
          zeroAddress,
        ]),
        'ZeroAddress',
      );
    });

    it('setExecutor(address(0)) disables execution without a full pause', async () => {
      const { soe, router, tokenIn, tokenOut, admin, executor, user } =
        await loadFixture(deployExecutorFixture);

      await soe.write.setExecutor([zeroAddress], { account: admin.account });
      await router.write.setNextAmountOut([QUOTED_OUT]);

      await expectRevert(
        soe.write.executeSwap(
          [
            executionId('exec-disabled'),
            user.account.address,
            tokenIn.address,
            tokenOut.address,
            POOL_FEE,
            HALF_WETH,
            MIN_OUT,
            await futureDeadline(),
          ],
          { account: executor.account },
        ),
        'AccessControlUnauthorizedAccount',
      );
    });
  });
});
