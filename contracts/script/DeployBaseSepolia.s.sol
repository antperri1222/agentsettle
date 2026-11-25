// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";

/**
 * Base Sepolia TESTNET deployment. Refuses to run anywhere else.
 *
 * Preconditions (see docs/RUNBOOK.md):
 *   CONFIRM_TESTNET_DEPLOY=base-sepolia   explicit, typed authorization
 *   TREASURY_ADDRESS                      non-zero, not the deployer
 * v2 has no deployment-wide arbiter: each job names its own (see AgentEscrow).
 *   FEE_BPS (optional, default 50)
 * Signer: a Foundry keystore account (`--account`), never a raw private key in env or prompts.
 *
 * USDC address verified 2026-11-03 at https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
contract DeployBaseSepolia is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    address public constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external returns (AgentEscrow escrow) {
        string memory confirm = vm.envOr("CONFIRM_TESTNET_DEPLOY", string(""));
        require(keccak256(bytes(confirm)) == keccak256("base-sepolia"), "Set CONFIRM_TESTNET_DEPLOY=base-sepolia");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint256 fee = vm.envOr("FEE_BPS", uint256(50));
        require(fee <= 1000, "FEE_BPS > 1000");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        preflight(deployer, treasury);
        escrow = new AgentEscrow(BASE_SEPOLIA_USDC, treasury, uint16(fee));
        vm.stopBroadcast();

        console.log("AgentEscrow deployed (Base Sepolia TESTNET):", address(escrow));
        console.log("Deploy block: read it from broadcast/DeployBaseSepolia.s.sol/84532/run-latest.json (see RUNBOOK)");
        console.log("Explorer: https://sepolia.basescan.org/address/%s", address(escrow));
    }

    /// @notice All network / asset / role checks. Public so tests can exercise it.
    function preflight(address deployer, address treasury) public view {
        require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "Not Base Sepolia (84532); refusing");
        require(BASE_SEPOLIA_USDC.code.length > 0, "No contract at verified USDC address");
        require(IERC20Metadata(BASE_SEPOLIA_USDC).decimals() == 6, "USDC decimals != 6");
        require(
            keccak256(bytes(IERC20Metadata(BASE_SEPOLIA_USDC).symbol())) == keccak256("USDC"), "Token symbol != USDC"
        );
        require(treasury != address(0), "Zero treasury address");
        require(treasury != deployer, "Treasury must not be the deployer key");
    }
}
