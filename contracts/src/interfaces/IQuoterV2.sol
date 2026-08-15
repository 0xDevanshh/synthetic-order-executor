// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/**
 * @title IQuoterV2
 * @notice Uniswap V3 QuoterV2. Sepolia: 0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3
 *
 * @dev Used OFF-CHAIN ONLY, by the backend's quote service.
 *
 *      Two important properties:
 *      1. These functions are state-mutating by design (they revert internally
 *         and decode the revert data), so they must be called with
 *         `simulateContract` / `eth_call`, never `readContract`.
 *      2. The contract deliberately never quotes on-chain during execution.
 *         Deriving the slippage bound from live spot price inside the same
 *         transaction would let a manipulated pool define its own bound, which
 *         defeats the protection entirely.
 */
interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}
