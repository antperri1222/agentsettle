// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Token that skims 1% on every transfer — must be rejected at funding.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("FoT", "FOT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 skim = value / 100;
            super._update(from, address(0xdead), skim);
            super._update(from, to, value - skim);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Token that calls back into the escrow on every outbound transfer, simulating a hostile hook.
contract ReentrantToken is ERC20 {
    AgentEscrow public target;
    uint256 public targetId;
    uint8 public mode; // 1 = approve, 2 = providerRefund, 3 = resolve
    bool public reentered;
    bytes public lastRevert;

    constructor() ERC20("Re", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }

    function arm(AgentEscrow t, uint256 id, uint8 m) external {
        target = t;
        targetId = id;
        mode = m;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (mode != 0 && from == address(target)) {
            uint8 m = mode;
            mode = 0; // single attempt
            reentered = true;
            bytes memory data;
            if (m == 1) data = abi.encodeCall(AgentEscrow.approve, (targetId));
            else if (m == 2) data = abi.encodeCall(AgentEscrow.providerRefund, (targetId));
            else data = abi.encodeCall(AgentEscrow.resolve, (targetId, true));
            (bool ok, bytes memory ret) = address(target).call(data);
            require(!ok, "reentrancy succeeded");
            lastRevert = ret;
        }
    }
}

contract AgentEscrowTest is Test {
    MockUSDC internal token;
    AgentEscrow internal escrow;
    address internal buyer = makeAddr("buyer");
    address internal provider = makeAddr("provider");
    address internal treasury = makeAddr("treasury");
    address internal arbiter = makeAddr("arbiter");
    address internal stranger = makeAddr("stranger");
    address internal agent = makeAddr("agent");
    bytes32 internal constant TERMS = keccak256("research brief");
    bytes32 internal constant EVIDENCE = keccak256("delivered brief");
    uint256 internal constant FIVE_USDC = 5_000_000;
    uint256 internal constant START = 100_000_000;
    uint256 internal refCounter;

    function setUp() public {
        vm.warp(1_750_000_000);
        token = new MockUSDC();
        escrow = new AgentEscrow(address(token), treasury, arbiter, 50);
        token.mint(buyer, START);
        vm.prank(buyer);
        token.approve(address(escrow), type(uint256).max);
    }

    function _ref() internal returns (bytes32) {
        return keccak256(abi.encode("ref", ++refCounter));
    }

    function _fund() internal returns (uint256) {
        vm.prank(buyer);
        return escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, _ref());
    }

    function _delivered() internal returns (uint256 id) {
        id = _fund();
        vm.prank(provider);
        escrow.deliver(id, EVIDENCE);
    }

    function _status(uint256 id) internal view returns (AgentEscrow.Status) {
        return escrow.getJob(id).status;
    }

    // ─────────────── constructor ───────────────

    function testConstructorRejectsBadConfig() public {
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        new AgentEscrow(address(0), treasury, arbiter, 50);
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        new AgentEscrow(address(token), address(0), arbiter, 50);
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        new AgentEscrow(address(token), treasury, address(0), 50);
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        new AgentEscrow(stranger, treasury, arbiter, 50); // EOA, not a token contract
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        new AgentEscrow(address(token), treasury, arbiter, 1001);
    }

    // ─────────────── happy paths ───────────────

    function testHappyPath() public {
        uint256 id = _fund();
        assertEq(token.balanceOf(address(escrow)), FIVE_USDC);
        assertEq(uint8(_status(id)), uint8(AgentEscrow.Status.Funded));
        vm.prank(provider);
        escrow.deliver(id, EVIDENCE);
        assertEq(escrow.getJob(id).evidenceHash, EVIDENCE);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.PaymentReleased(id, 4_975_000, 25_000, buyer);
        vm.prank(buyer);
        escrow.approve(id);
        assertEq(token.balanceOf(provider), 4_975_000);
        assertEq(token.balanceOf(treasury), 25_000);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(_status(id)), uint8(AgentEscrow.Status.Paid));
    }

    function testRefundAfterMissedDeadline() public {
        uint256 id = _fund();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(buyer);
        escrow.refundExpired(id);
        assertEq(token.balanceOf(buyer), START);
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
        assertEq(token.balanceOf(buyer), START);
    }

    function testDisputeAndPay() public {
        uint256 id = _delivered();
        vm.prank(provider);
        escrow.dispute(id);
        vm.prank(arbiter);
        escrow.resolve(id, true);
        assertEq(token.balanceOf(provider), 4_975_000);
        assertEq(token.balanceOf(treasury), 25_000);
    }

    function testProviderVoluntaryRefundAfterDelivery() public {
        uint256 id = _delivered();
        vm.prank(provider);
        escrow.providerRefund(id);
        assertEq(token.balanceOf(buyer), START);
    }

    function testDeliveryAllowedExactlyAtDeadlineAndRefundNot() public {
        uint256 id = _fund();
        vm.warp(escrow.getJob(id).deadline);
        vm.prank(buyer);
        vm.expectRevert(AgentEscrow.DeadlineNotPassed.selector);
        escrow.refundExpired(id);
        vm.prank(provider);
        escrow.deliver(id, EVIDENCE);
    }

    // ─────────────── double settlement / finality ───────────────

    function testCannotPayTwice() public {
        uint256 id = _delivered();
        vm.startPrank(buyer);
        escrow.approve(id);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.approve(id);
        vm.stopPrank();
    }

    function testTerminalStatesAreFinal() public {
        uint256 paid = _delivered();
        vm.prank(buyer);
        escrow.approve(paid);
        uint256 refunded = _fund();
        vm.prank(provider);
        escrow.providerRefund(refunded);

        uint256[2] memory ids = [paid, refunded];
        for (uint256 i; i < 2; i++) {
            uint256 id = ids[i];
            vm.prank(provider);
            vm.expectRevert(AgentEscrow.InvalidState.selector);
            escrow.deliver(id, EVIDENCE);
            vm.prank(buyer);
            vm.expectRevert(AgentEscrow.InvalidState.selector);
            escrow.approve(id);
            vm.prank(buyer);
            vm.expectRevert(AgentEscrow.InvalidState.selector);
            escrow.dispute(id);
            vm.prank(arbiter);
            vm.expectRevert(AgentEscrow.InvalidState.selector);
            escrow.resolve(id, true);
            vm.prank(provider);
            vm.expectRevert(AgentEscrow.InvalidState.selector);
            escrow.providerRefund(id);
            vm.warp(block.timestamp + 2 days);
            vm.prank(buyer);
            vm.expectRevert(AgentEscrow.InvalidState.selector);
            escrow.refundExpired(id);
        }
    }

    function testCannotResolveTwice() public {
        uint256 id = _fund();
        vm.prank(buyer);
        escrow.dispute(id);
        vm.startPrank(arbiter);
        escrow.resolve(id, false);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.resolve(id, true);
        vm.stopPrank();
    }

    // ─────────────── authorization ───────────────

    function testUnauthorizedDelivery() public {
        uint256 id = _fund();
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        vm.prank(buyer);
        escrow.deliver(id, EVIDENCE);
    }

    function testStrangerCannotTouchJob() public {
        uint256 id = _delivered();
        vm.startPrank(stranger);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.approve(id);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.dispute(id);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.resolve(id, true);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.providerRefund(id);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.refundExpired(id);
        vm.stopPrank();
    }

    function testProviderCannotApproveOwnWork() public {
        uint256 id = _delivered();
        vm.prank(provider);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.approve(id);
    }

    function testArbiterCannotActOutsideDispute() public {
        uint256 id = _delivered();
        vm.startPrank(arbiter);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.resolve(id, true);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.approve(id);
        vm.stopPrank();
    }

    function testNonexistentJob() public {
        vm.prank(buyer);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.approve(999);
        vm.prank(arbiter);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.resolve(999, true);
        // address(0) can never act: no real signer controls it
        vm.prank(address(0));
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.approve(999);
    }

    function testNoProviderRefundAfterPayment() public {
        uint256 id = _delivered();
        vm.prank(buyer);
        escrow.approve(id);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        vm.prank(provider);
        escrow.providerRefund(id);
    }

    function testApproveRequiresDelivery() public {
        uint256 id = _fund();
        vm.prank(buyer);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.approve(id);
    }

    function testLateDeliveryRejected() public {
        uint256 id = _fund();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(provider);
        vm.expectRevert(AgentEscrow.DeadlinePassed.selector);
        escrow.deliver(id, EVIDENCE);
    }

    function testCannotRefundExpiredAfterDelivery() public {
        uint256 id = _delivered();
        vm.warp(block.timestamp + 2 days);
        vm.prank(buyer);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.refundExpired(id);
    }

    // ─────────────── input validation ───────────────

    function testRejectsBadCreateInputs() public {
        uint64 dl = uint64(block.timestamp + 1 days);
        vm.startPrank(buyer);
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        escrow.createJob(provider, 0, dl, TERMS, _ref());
        vm.expectRevert(AgentEscrow.InvalidCommitment.selector);
        escrow.createJob(provider, FIVE_USDC, dl, bytes32(0), _ref());
        vm.expectRevert(AgentEscrow.InvalidCommitment.selector);
        escrow.createJob(provider, FIVE_USDC, dl, TERMS, bytes32(0));
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        escrow.createJob(address(0), FIVE_USDC, dl, TERMS, _ref());
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        escrow.createJob(buyer, FIVE_USDC, dl, TERMS, _ref());
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        escrow.createJob(arbiter, FIVE_USDC, dl, TERMS, _ref());
        vm.expectRevert(AgentEscrow.InvalidDeadline.selector);
        escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp), TERMS, _ref());
        vm.expectRevert(AgentEscrow.InvalidDeadline.selector);
        escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 91 days), TERMS, _ref());
        vm.stopPrank();
    }

    function testArbiterCannotBeBuyer() public {
        token.mint(arbiter, FIVE_USDC);
        vm.startPrank(arbiter);
        token.approve(address(escrow), FIVE_USDC);
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, _ref());
        vm.stopPrank();
    }

    function testRejectsEmptyEvidence() public {
        uint256 id = _fund();
        vm.prank(provider);
        vm.expectRevert(AgentEscrow.InvalidCommitment.selector);
        escrow.deliver(id, bytes32(0));
    }

    function testInsufficientAllowanceReverts() public {
        address poor = makeAddr("poor");
        token.mint(poor, FIVE_USDC);
        vm.prank(poor);
        vm.expectRevert(); // ERC20InsufficientAllowance
        escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, _ref());
        assertEq(escrow.nextId(), 0);
    }

    // ─────────────── idempotency ───────────────

    function testDuplicateClientRefRejected() public {
        bytes32 ref = keccak256("retry-me");
        vm.startPrank(buyer);
        uint256 id = escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, ref);
        vm.expectRevert(AgentEscrow.DuplicateClientRef.selector);
        escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, ref);
        vm.stopPrank();
        assertEq(escrow.jobIdByRef(buyer, ref), id);
        assertEq(token.balanceOf(address(escrow)), FIVE_USDC); // only funded once
    }

    function testClientRefScopedPerBuyer() public {
        bytes32 ref = keccak256("shared");
        address other = makeAddr("other");
        token.mint(other, FIVE_USDC);
        vm.prank(other);
        token.approve(address(escrow), FIVE_USDC);
        vm.prank(buyer);
        escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, ref);
        vm.prank(other); // another buyer cannot be griefed by front-running the same ref
        escrow.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, ref);
    }

    // ─────────────── adversarial tokens ───────────────

    function testRejectsFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        AgentEscrow e = new AgentEscrow(address(fot), treasury, arbiter, 50);
        fot.mint(buyer, START);
        vm.startPrank(buyer);
        fot.approve(address(e), type(uint256).max);
        vm.expectRevert(AgentEscrow.FeeOnTransferNotSupported.selector);
        e.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, _ref());
        vm.stopPrank();
    }

    function _reentrantSetup() internal returns (ReentrantToken rt, AgentEscrow e, uint256 id) {
        rt = new ReentrantToken();
        e = new AgentEscrow(address(rt), treasury, arbiter, 50);
        rt.mint(buyer, START);
        vm.startPrank(buyer);
        rt.approve(address(e), type(uint256).max);
        id = e.createJob(provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, _ref());
        vm.stopPrank();
        vm.prank(provider);
        e.deliver(id, EVIDENCE);
    }

    function testReentrancyOnApproveBlocked() public {
        (ReentrantToken rt, AgentEscrow e, uint256 id) = _reentrantSetup();
        rt.arm(e, id, 1);
        vm.prank(buyer);
        e.approve(id);
        assertTrue(rt.reentered());
        assertEq(rt.balanceOf(provider), 4_975_000);
        assertEq(rt.balanceOf(address(e)), 0);
    }

    function testReentrancyOnRefundBlocked() public {
        (ReentrantToken rt, AgentEscrow e, uint256 id) = _reentrantSetup();
        rt.arm(e, id, 2);
        vm.prank(provider);
        e.providerRefund(id);
        assertTrue(rt.reentered());
        assertEq(rt.balanceOf(buyer), START);
        assertEq(rt.balanceOf(provider), 0);
    }

    // ─────────────── delegated agent spend policy ───────────────

    function _grant(uint128 perJob, uint128 daily) internal {
        vm.startPrank(buyer);
        escrow.setPolicy(agent, perJob, daily, uint64(block.timestamp + 30 days));
        escrow.setProviderAllowed(agent, provider, true);
        vm.stopPrank();
    }

    function _agentCreate(uint256 amount) internal returns (uint256) {
        vm.prank(agent);
        return escrow.createJobAsAgent(buyer, provider, amount, uint64(block.timestamp + 1 days), TERMS, _ref());
    }

    function testAgentHappyPathFundsFromOwner() public {
        _grant(10_000_000, 25_000_000);
        uint256 id = _agentCreate(FIVE_USDC);
        AgentEscrow.Job memory j = escrow.getJob(id);
        assertEq(j.buyer, buyer);
        assertEq(j.agent, agent);
        assertEq(token.balanceOf(agent), 0);
        vm.prank(provider);
        escrow.deliver(id, EVIDENCE);
        vm.prank(agent); // agent may approve within its budget
        escrow.approve(id);
        assertEq(token.balanceOf(provider), 4_975_000);
    }

    function testAgentRefundGoesToOwnerNotAgent() public {
        _grant(10_000_000, 25_000_000);
        uint256 id = _agentCreate(FIVE_USDC);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agent);
        escrow.refundExpired(id);
        assertEq(token.balanceOf(buyer), START);
        assertEq(token.balanceOf(agent), 0);
    }

    function testAgentWithoutPolicyRejected() public {
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.PolicyInactive.selector);
        escrow.createJobAsAgent(buyer, provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, _ref());
    }

    function testAgentPerJobCap() public {
        _grant(10_000_000, 25_000_000);
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.PerJobCapExceeded.selector);
        escrow.createJobAsAgent(buyer, provider, 10_000_001, uint64(block.timestamp + 1 days), TERMS, _ref());
    }

    function testAgentDailyCapAndRollover() public {
        _grant(10_000_000, 25_000_000);
        _agentCreate(10_000_000);
        _agentCreate(10_000_000);
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.DailyCapExceeded.selector);
        escrow.createJobAsAgent(buyer, provider, 5_000_001, uint64(block.timestamp + 1 days), TERMS, _ref());
        _agentCreate(5_000_000); // exactly at cap is fine
        vm.warp(block.timestamp + 1 days);
        _agentCreate(10_000_000); // new day, new budget
    }

    function testRefundDoesNotRestoreDailyBudget() public {
        _grant(10_000_000, 10_000_000);
        uint256 id = _agentCreate(10_000_000);
        vm.prank(provider);
        escrow.providerRefund(id);
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.DailyCapExceeded.selector);
        escrow.createJobAsAgent(buyer, provider, 1, uint64(block.timestamp + 1 days), TERMS, _ref());
    }

    function testAgentAllowlistEnforced() public {
        _grant(10_000_000, 25_000_000);
        address rogue = makeAddr("rogue");
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.ProviderNotAllowed.selector);
        escrow.createJobAsAgent(buyer, rogue, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, _ref());
    }

    function testAgentCannotPayItself() public {
        _grant(10_000_000, 25_000_000);
        vm.prank(buyer);
        escrow.setProviderAllowed(agent, agent, true);
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        escrow.createJobAsAgent(buyer, agent, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, _ref());
    }

    function testPolicyRevocationAndExpiry() public {
        _grant(10_000_000, 25_000_000);
        _agentCreate(FIVE_USDC);
        vm.prank(buyer);
        escrow.revokePolicy(agent);
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.PolicyInactive.selector);
        escrow.createJobAsAgent(buyer, provider, 1, uint64(block.timestamp + 1 days), TERMS, _ref());

        _grant(10_000_000, 25_000_000);
        vm.warp(block.timestamp + 30 days);
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.PolicyInactive.selector);
        escrow.createJobAsAgent(buyer, provider, 1, uint64(block.timestamp + 1 days), TERMS, _ref());
    }

    function testPolicyIsPerOwner() public {
        // An agent authorised by `buyer` cannot spend a different owner's allowance.
        _grant(10_000_000, 25_000_000);
        address victim = makeAddr("victim");
        token.mint(victim, START);
        vm.prank(victim);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.PolicyInactive.selector);
        escrow.createJobAsAgent(victim, provider, FIVE_USDC, uint64(block.timestamp + 1 days), TERMS, _ref());
    }

    function testAgentOfOneJobCannotActOnAnother() public {
        _grant(10_000_000, 25_000_000);
        uint256 direct = _delivered(); // created by buyer directly, agent field empty
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.approve(direct);
    }

    function testSetPolicyValidation() public {
        vm.startPrank(buyer);
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        escrow.setPolicy(address(0), 1, 1, uint64(block.timestamp + 1));
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        escrow.setPolicy(buyer, 1, 1, uint64(block.timestamp + 1));
        vm.expectRevert(AgentEscrow.InvalidAddress.selector);
        escrow.setPolicy(arbiter, 1, 1, uint64(block.timestamp + 1));
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        escrow.setPolicy(agent, 0, 1, uint64(block.timestamp + 1));
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        escrow.setPolicy(agent, 2, 1, uint64(block.timestamp + 1));
        vm.expectRevert(AgentEscrow.InvalidDeadline.selector);
        escrow.setPolicy(agent, 1, 1, uint64(block.timestamp));
        vm.stopPrank();
    }

    // ─────────────── fuzz ───────────────

    function testFuzzFeeConservation(uint256 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 1000));
        amount = bound(amount, 1, 1e15); // up to 1B USDC
        AgentEscrow e = new AgentEscrow(address(token), treasury, arbiter, bps);
        (uint256 payout, uint256 fee) = e.quote(amount);
        assertEq(payout + fee, amount);
        assertLe(fee * 10_000, amount * bps);
    }

    function testFuzzSettlementConservesBalances(uint256 amount, bool viaDispute, bool pay) public {
        amount = bound(amount, 1, START);
        vm.prank(buyer);
        uint256 id = escrow.createJob(provider, amount, uint64(block.timestamp + 1 days), TERMS, _ref());
        vm.prank(provider);
        escrow.deliver(id, EVIDENCE);
        if (viaDispute) {
            vm.prank(buyer);
            escrow.dispute(id);
            vm.prank(arbiter);
            escrow.resolve(id, pay);
        } else if (pay) {
            vm.prank(buyer);
            escrow.approve(id);
        } else {
            vm.prank(provider);
            escrow.providerRefund(id);
        }
        uint256 total = token.balanceOf(buyer) + token.balanceOf(provider) + token.balanceOf(treasury);
        assertEq(total, START);
        assertEq(token.balanceOf(address(escrow)), 0);
        (uint256 payout, uint256 fee) = escrow.quote(amount);
        if (pay) {
            assertEq(token.balanceOf(provider), payout);
            assertEq(token.balanceOf(treasury), fee);
        } else {
            assertEq(token.balanceOf(buyer), START);
        }
    }

    function testFuzzRandomCallerCannotSettle(address caller) public {
        vm.assume(caller != buyer && caller != provider && caller != arbiter && caller != address(0));
        uint256 id = _delivered();
        vm.startPrank(caller);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.approve(id);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.resolve(id, true);
        vm.expectRevert(AgentEscrow.Forbidden.selector);
        escrow.providerRefund(id);
        vm.stopPrank();
    }

    function testFuzzAgentNeverExceedsDailyCap(uint128[6] memory amounts) public {
        uint128 cap = 25_000_000;
        _grant(10_000_000, cap);
        uint256 spent;
        for (uint256 i; i < amounts.length; i++) {
            uint256 a = bound(amounts[i], 1, 10_000_000);
            vm.prank(agent);
            try escrow.createJobAsAgent(buyer, provider, a, uint64(block.timestamp + 1 days), TERMS, _ref()) {
                spent += a;
            } catch {}
        }
        assertLe(spent, cap);
        assertEq(token.balanceOf(address(escrow)), spent);
    }
}
