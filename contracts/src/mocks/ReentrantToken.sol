// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Malicious ERC20 that re-enters the executor during a transfer.
 *
 * @dev Used to prove that ReentrancyGuard plus checks-effects-interactions
 *      ordering hold. `attackSucceeded` stays false if the re-entrant call
 *      reverts, which is the assertion the test makes.
 */
contract ReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public attackSucceeded;
    bool public attackAttempted;

    constructor() ERC20("Reentrant", "REENT") {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && !attackAttempted) {
            attackAttempted = true;
            (bool ok, ) = target.call(payload);
            attackSucceeded = ok;
        }
        super._update(from, to, value);
    }
}
