// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Canonical WETH9. Sepolia: 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14
interface IWETH9 is IERC20 {
    /// @notice Wrap sent ETH into WETH.
    function deposit() external payable;

    /// @notice Unwrap WETH back into ETH.
    function withdraw(uint256 amount) external;
}
