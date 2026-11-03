// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeployBaseSepolia} from "../script/DeployBaseSepolia.s.sol";

contract FakeToken is ERC20 {
    uint8 internal immutable _dec;

    constructor(string memory sym, uint8 dec) ERC20("Fake", sym) {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }
}

/// Exercises deploy-script guards without touching any real network.
contract DeployBaseSepoliaTest is Test {
    DeployBaseSepolia internal script;
    address internal deployer = makeAddr("deployer");
    address internal treasury = makeAddr("treasury");
    address internal arbiter = makeAddr("arbiter");
    address internal usdc;

    function setUp() public {
        script = new DeployBaseSepolia();
        usdc = script.BASE_SEPOLIA_USDC();
    }

    function _etch(string memory sym, uint8 dec) internal {
        // ERC20 name/symbol live in storage, so deploy normally then copy code + the two string slots.
        FakeToken t = new FakeToken(sym, dec);
        vm.etch(usdc, address(t).code);
        vm.store(usdc, bytes32(uint256(3)), vm.load(address(t), bytes32(uint256(3))));
        vm.store(usdc, bytes32(uint256(4)), vm.load(address(t), bytes32(uint256(4))));
    }

    function testRefusesWrongChain() public {
        _etch("USDC", 6);
        vm.chainId(31337);
        vm.expectRevert(bytes("Not Base Sepolia (84532); refusing"));
        script.preflight(deployer, treasury, arbiter);
        vm.chainId(8453); // Base mainnet
        vm.expectRevert(bytes("Not Base Sepolia (84532); refusing"));
        script.preflight(deployer, treasury, arbiter);
    }

    function testRefusesMissingOrWrongToken() public {
        vm.chainId(84532);
        vm.expectRevert(bytes("No contract at verified USDC address"));
        script.preflight(deployer, treasury, arbiter);
        _etch("USDC", 18);
        vm.expectRevert(bytes("USDC decimals != 6"));
        script.preflight(deployer, treasury, arbiter);
        _etch("mUSDC", 6);
        vm.expectRevert(bytes("Token symbol != USDC"));
        script.preflight(deployer, treasury, arbiter);
    }

    function testRefusesBadRoles() public {
        vm.chainId(84532);
        _etch("USDC", 6);
        vm.expectRevert(bytes("Treasury and arbiter must differ"));
        script.preflight(deployer, treasury, treasury);
        vm.expectRevert(bytes("Arbiter must not be the deployer key"));
        script.preflight(deployer, treasury, deployer);
        script.preflight(deployer, treasury, arbiter); // passes
    }

    function testRunRequiresExplicitConfirmation() public {
        vm.chainId(84532);
        _etch("USDC", 6);
        vm.setEnv("CONFIRM_TESTNET_DEPLOY", "yes");
        vm.setEnv("TREASURY_ADDRESS", vm.toString(treasury));
        vm.setEnv("ARBITER_ADDRESS", vm.toString(arbiter));
        vm.expectRevert(bytes("Set CONFIRM_TESTNET_DEPLOY=base-sepolia"));
        script.run();
    }
}
