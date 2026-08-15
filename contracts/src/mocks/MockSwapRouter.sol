// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";

/**
 * @notice Deterministic stand-in for Uniswap SwapRouter02 in unit tests.
 *
 * @dev Behaves like the real router in the ways that matter to the caller: it
 *      pulls `amountIn` via the approval it was granted, enforces
 *      `amountOutMinimum`, and pays `recipient`. Tests drive the exact output
 *      via `setNextAmountOut`, which is what makes the slippage and accounting
 *      branches reachable without a live pool.
 *
 *      Must be pre-funded with tokenOut by the test.
 */
contract MockSwapRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    /// @notice Output paid by the next swap, in tokenOut units.
    uint256 public nextAmountOut;

    /// @notice When set, revert the way a pool does when it cannot fill.
    bool public shouldRevert;

    /// @notice Records the allowance seen at call time, so tests can assert the
    ///         executor grants a scoped approval rather than an infinite one.
    uint256 public observedAllowance;

    error MockRouterForcedRevert();
    error MockRouterTooLittleReceived();

    function setNextAmountOut(uint256 amount) external {
        nextAmountOut = amount;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        if (shouldRevert) revert MockRouterForcedRevert();

        observedAllowance = IERC20(params.tokenIn).allowance(msg.sender, address(this));

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        amountOut = nextAmountOut;

        // The real router reverts with 'Too little received' rather than
        // silently underfilling. Mirror that so the executor's own guard is
        // tested against realistic router behaviour.
        if (amountOut < params.amountOutMinimum) revert MockRouterTooLittleReceived();

        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }

    function exactInput(ExactInputParams calldata) external payable override returns (uint256) {
        revert("MockSwapRouter: multi-hop not supported");
    }
}
