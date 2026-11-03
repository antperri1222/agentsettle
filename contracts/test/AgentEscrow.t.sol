// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract AgentEscrowTest is Test {
    MockUSDC internal token;
    AgentEscrow internal escrow;
    address internal buyer = makeAddr("buyer");
    address internal provider = makeAddr("provider");
    address internal treasury = makeAddr("treasury");
    address internal arbiter = makeAddr("arbiter");
    bytes32 internal constant TERMS = keccak256("research brief");
    bytes32 internal constant EVIDENCE = keccak256("delivered brief");
    uint256 internal constant FIVE_USDC = 5_000_000;

    function setUp() public {
        token = new MockUSDC();
        escrow = new AgentEscrow(address(token), treasury, arbiter, 50);
        token.mint(buyer, 100_000_000);
        vm.prank(buyer);
        token.approve(address(escrow), type(uint256).max);
    }

    function _fund() internal returns (uint256) {
        vm.prank(buyer);
        return escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS);
    }

    function testHappyPath() public {
        uint256 id = _fund();
        assertEq(token.balanceOf(address(escrow)), FIVE_USDC);
        vm.prank(provider);
        escrow.deliver(id, EVIDENCE);
        vm.prank(buyer);
        escrow.approve(id);
        assertEq(token.balanceOf(provider), 4_975_000);
        assertEq(token.balanceOf(treasury), 25_000);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testCannotPayTwice() public {
        uint256 id = _fund();
        vm.prank(provider);
        escrow.deliver(id, EVIDENCE);
        vm.startPrank(buyer);
        escrow.approve(id);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.approve(id);
        vm.stopPrank();
    }

    function testUnauthorizedDelivery() public {
        uint256 id = _fund();
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        vm.prank(buyer);
        escrow.deliver(id, EVIDENCE);
    }

    function testRefundAfterMissedDeadline() public {
        uint256 id = _fund();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(buyer);
        escrow.refundExpired(id);
        assertEq(token.balanceOf(buyer), 100_000_000);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testDisputeAndRefund() public {
        uint256 id = _fund();
        vm.prank(buyer);
        escrow.dispute(id);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        vm.prank(buyer);
        escrow.resolve(id, false);
        vm.prank(arbiter);
        escrow.resolve(id, false);
        assertEq(token.balanceOf(buyer), 100_000_000);
    }

    function testDisputeAndPay() public {
        uint256 id = _fund();
        vm.prank(buyer);
        escrow.dispute(id);
        vm.prank(arbiter);
        escrow.resolve(id, true);
        assertEq(token.balanceOf(provider), 4_975_000);
    }

    function testNoProviderRefundAfterPayment() public {
        uint256 id = _fund();
        vm.prank(provider);
        escrow.deliver(id, EVIDENCE);
        vm.prank(buyer);
        escrow.approve(id);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        vm.prank(provider);
        escrow.providerRefund(id);
    }

    function testRejectsZeroTermsAndZeroPayment() public {
        vm.startPrank(buyer);
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        escrow.createJob(provider, 0, uint64(block.timestamp + 1 days), TERMS);
        vm.expectRevert(AgentEscrow.InvalidCommitment.selector);
        escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), bytes32(0));
        vm.stopPrank();
    }
}
