// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @dev Drives random sequences of legitimate and illegitimate actions against the escrow.
contract EscrowHandler is Test {
    AgentEscrow public escrow;
    MockUSDC public token;
    address public buyer;
    address public provider;
    address public arbiter;
    address public stranger;

    uint256 public refNonce;
    uint256 public ghostPaidOut; // provider payouts
    uint256 public ghostFees;
    uint256 public ghostRefunded;
    uint256 public ghostFunded;
    uint256 public payCount;
    uint256 public refundCount;
    mapping(uint256 => uint8) public settledCount; // id => number of terminal transitions observed

    constructor(AgentEscrow e, MockUSDC t, address b, address p, address a) {
        escrow = e;
        token = t;
        buyer = b;
        provider = p;
        arbiter = a;
        stranger = makeAddr("inv-stranger");
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        uint256 n = escrow.nextId();
        return n == 0 ? 0 : (seed % n) + 1;
    }

    /// ~70% of calls come from the role that is allowed to act; the rest from a random (often wrong) actor.
    function _who(uint256 seed, address intended) internal view returns (address) {
        if (seed % 10 < 7) return intended;
        uint256 r = (seed / 10) % 4;
        return r == 0 ? buyer : r == 1 ? provider : r == 2 ? arbiter : stranger;
    }

    function _pickOpen(uint256 seed) internal view returns (uint256) {
        // bias toward the most recent jobs so lifecycles progress instead of scattering
        uint256 n = escrow.nextId();
        if (n == 0) return 0;
        uint256 window = n < 4 ? n : 4;
        return n - (seed % window);
    }

    function create(uint256 amount, uint32 duration) external {
        amount = bound(amount, 1, 20_000_000);
        if (token.balanceOf(buyer) < amount) return;
        duration = uint32(bound(duration, 1, 30 days));
        vm.prank(buyer);
        escrow.createJob(provider, arbiter, amount, uint64(block.timestamp + duration), keccak256("t"), bytes32(++refNonce));
        ghostFunded += amount;
    }

    function deliver(uint256 seed, uint256 whoSeed) external {
        uint256 id = seed % 2 == 0 ? _pickOpen(seed / 2) : _pick(seed / 2);
        vm.prank(_who(whoSeed, provider));
        try escrow.deliver(id, keccak256(abi.encode(id))) {} catch {}
    }

    function approve(uint256 seed, uint256 whoSeed) external {
        _settle(seed, whoSeed, 0, false);
    }

    function dispute(uint256 seed, uint256 whoSeed) external {
        uint256 id = seed % 2 == 0 ? _pickOpen(seed / 2) : _pick(seed / 2);
        vm.prank(_who(whoSeed, whoSeed % 2 == 0 ? buyer : provider));
        try escrow.dispute(id) {} catch {}
    }

    function resolve(uint256 seed, uint256 whoSeed, bool pay) external {
        _settle(seed, whoSeed, 1, pay);
    }

    function refundExpired(uint256 seed, uint256 whoSeed) external {
        _settle(seed, whoSeed, 2, false);
    }

    function providerRefund(uint256 seed, uint256 whoSeed) external {
        _settle(seed, whoSeed, 3, false);
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }

    function _settle(uint256 seed, uint256 whoSeed, uint8 kind, bool pay) internal {
        uint256 id = seed % 2 == 0 ? _pickOpen(seed / 2) : _pick(seed / 2);
        if (id == 0) return;
        uint256 amount = escrow.getJob(id).amount;
        address intended = kind == 1 ? arbiter : kind == 3 ? provider : buyer;
        address caller = _who(whoSeed, intended);
        vm.prank(caller);
        bool ok;
        if (kind == 0) {
            try escrow.approve(id) {
                ok = true;
                pay = true;
            } catch {}
        } else if (kind == 1) {
            try escrow.resolve(id, pay) {
                ok = true;
            } catch {}
        } else if (kind == 2) {
            try escrow.refundExpired(id) {
                ok = true;
                pay = false;
            } catch {}
        } else {
            try escrow.providerRefund(id) {
                ok = true;
                pay = false;
            } catch {}
        }
        if (!ok) return;
        settledCount[id]++;
        if (pay) {
            (uint256 payout, uint256 fee) = escrow.quote(amount);
            ghostPaidOut += payout;
            ghostFees += fee;
            payCount++;
        } else {
            ghostRefunded += amount;
            refundCount++;
        }
    }
}

contract AgentEscrowInvariantTest is Test {
    AgentEscrow internal escrow;
    MockUSDC internal token;
    EscrowHandler internal handler;
    address internal buyer = makeAddr("buyer");
    address internal provider = makeAddr("provider");
    address internal treasury = makeAddr("treasury");
    address internal arbiter = makeAddr("arbiter");
    uint256 internal constant START = 1_000_000_000;

    function setUp() public {
        vm.warp(1_750_000_000);
        token = new MockUSDC();
        escrow = new AgentEscrow(address(token), treasury, 50);
        token.mint(buyer, START);
        vm.prank(buyer);
        token.approve(address(escrow), type(uint256).max);
        handler = new EscrowHandler(escrow, token, buyer, provider, arbiter);
        targetContract(address(handler));
    }

    /// Escrow holds exactly the sum of open (non-terminal) job amounts.
    function invariant_escrowBalanceEqualsOpenJobs() public view {
        uint256 open;
        uint256 n = escrow.nextId();
        for (uint256 id = 1; id <= n; id++) {
            AgentEscrow.Job memory j = escrow.getJob(id);
            if (
                j.status == AgentEscrow.Status.Funded || j.status == AgentEscrow.Status.Delivered
                    || j.status == AgentEscrow.Status.Disputed
            ) open += j.amount;
        }
        assertEq(token.balanceOf(address(escrow)), open);
    }

    /// No value is created or destroyed across all participants.
    function invariant_totalConservation() public view {
        uint256 sum = token.balanceOf(buyer) + token.balanceOf(provider) + token.balanceOf(treasury)
            + token.balanceOf(address(escrow));
        assertEq(sum, START);
        assertEq(token.balanceOf(arbiter), 0);
    }

    /// Ledger matches ghost accounting from successful calls.
    function invariant_ghostAccounting() public view {
        assertEq(token.balanceOf(provider), handler.ghostPaidOut());
        assertEq(token.balanceOf(treasury), handler.ghostFees());
        assertEq(
            token.balanceOf(address(escrow)),
            handler.ghostFunded() - handler.ghostPaidOut() - handler.ghostFees() - handler.ghostRefunded()
        );
    }

    /// Each job settles at most once.
    function invariant_settleAtMostOnce() public view {
        uint256 n = escrow.nextId();
        for (uint256 id = 1; id <= n; id++) {
            assertLe(handler.settledCount(id), 1);
        }
    }
}
