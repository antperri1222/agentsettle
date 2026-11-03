// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 *  @notice UNRESTRICTED TEST-ONLY minting. Never deploy as a real stablecoin.
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC - TEST ONLY", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 value) external {
        _mint(to, value);
    }
}
