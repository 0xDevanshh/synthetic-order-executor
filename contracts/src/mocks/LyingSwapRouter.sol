// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";

/**
 * @notice A router that ignores `amountOutMinimum` and underdelivers silently.
 *
 * @dev Exists to prove the executor's own post-swap
 *      `amountOut >= minAmountOut` check is real rather than decorative. Against
 *      the honest MockSwapRouter that branch is unreachable, because the router
 *      reverts first — which is exactly why a compromised or buggy router needs
 *      its own test.
 */
contract LyingSwapRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    uint256 public nextAmountOut;

    function setNextAmountOut(uint256 amount) external {
        nextAmountOut = amount;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        // Deliberately does NOT honour params.amountOutMinimum.
        amountOut = nextAmountOut;
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }

    function exactInput(ExactInputParams calldata) external payable override returns (uint256) {
        revert("LyingSwapRouter: multi-hop not supported");
    }
}
