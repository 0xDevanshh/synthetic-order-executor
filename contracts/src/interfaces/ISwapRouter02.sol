// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/**
 * @title ISwapRouter02
 * @notice Minimal surface of Uniswap V3 SwapRouter02 used by SyntheticOrderExecutor.
 * @dev Sepolia: 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E
 *
 *      SwapRouter02's ExactInputSingleParams has NO `deadline` field — that was
 *      the legacy SwapRouter. Deadline enforcement therefore lives in
 *      SyntheticOrderExecutor.executeOrder, checked against block.timestamp.
 */
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another.
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Multi-hop variant. Reserved for future multi-hop routing support.
    function exactInput(ExactInputParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
