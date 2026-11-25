// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AgentEscrow
 * @notice Testnet research prototype: buyer-funded escrow for agent-delivered work.
 * @dev NOT AUDITED. No admin keys, no upgradeability, no pause.
 *      v2: every job names its own arbiter, fixed at creation, so disputes can be settled by a third party both sides
 *      can see before any work starts (the provider can decline a job by refunding it). The arbiter can never be the
 *      buyer, the buyer's agent or the provider. Agents may only name arbiters their owner has allowlisted.
 *      Trust assumption: a named arbiter that never acts leaves a disputed job frozen (see docs/THREAT_MODEL.md).
 *      Use only a non-fee-on-transfer six-decimal USDC-compatible token.
 *
 *      Two ways to fund a job:
 *        1. createJob            — msg.sender is the buyer and pays directly.
 *        2. createJobAsAgent     — a delegated agent key spends from an owner's allowance, bounded by an
 *                                  on-chain SpendPolicy (per-job cap, daily cap, provider allowlist, expiry).
 *      In both cases funds come from `buyer` and refunds return to `buyer`. The agent key never receives funds.
 *
 *      Every job carries a buyer-chosen `clientRef` that is unique per buyer: a retried createJob reverts
 *      with DuplicateClientRef instead of funding a second escrow (on-chain idempotency).
 */
contract AgentEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Funded,
        Delivered,
        Disputed,
        Paid,
        Refunded
    }

    struct Job {
        address buyer; // funds source, refund destination
        uint64 deadline;
        Status status;
        address provider;
        address agent; // optional delegated key that may act for the buyer (approve / dispute / refundExpired)
        address arbiter; // the only address that can resolve a dispute on this job
        uint256 amount; // token base units (6 decimals for USDC)
        bytes32 termsHash;
        bytes32 evidenceHash;
        bytes32 clientRef;
    }

    /// @notice Owner-defined limits for one agent key. All amounts in token base units.
    struct SpendPolicy {
        uint128 perJobCap;
        uint128 dailyCap;
        uint64 expiresAt; // unix seconds; policy is inactive at or after this time
        bool active;
    }

    uint64 public constant MAX_DURATION = 90 days;
    uint16 public constant MAX_FEE_BPS = 1000; // 10%
    uint8 public constant VERSION = 2;

    IERC20 public immutable usdc;
    address public immutable treasury;
    uint16 public immutable feeBps;

    uint256 public nextId;
    mapping(uint256 => Job) internal _jobs;
    /// @notice buyer => clientRef => jobId (0 = unused)
    mapping(address => mapping(bytes32 => uint256)) public jobIdByRef;

    /// @notice owner => agent => policy
    mapping(address => mapping(address => SpendPolicy)) public policies;
    /// @notice owner => agent => provider => allowed
    mapping(address => mapping(address => mapping(address => bool))) public providerAllowed;
    /// @notice owner => agent => arbiter => allowed
    mapping(address => mapping(address => mapping(address => bool))) public arbiterAllowed;
    /// @notice owner => agent => utc day index => amount authorised that day (refunds do not restore budget)
    mapping(address => mapping(address => mapping(uint256 => uint256))) public spentPerDay;

    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error InvalidCommitment();
    error Forbidden();
    error InvalidState();
    error DeadlineNotPassed();
    error DeadlinePassed();
    error FeeOnTransferNotSupported();
    error DuplicateClientRef();
    error PolicyInactive();
    error ProviderNotAllowed();
    error ArbiterNotAllowed();
    error PerJobCapExceeded();
    error DailyCapExceeded();

    event JobCreated(
        uint256 indexed id,
        address indexed buyer,
        address indexed provider,
        address agent,
        address arbiter,
        uint256 amount,
        uint64 deadline,
        bytes32 termsHash,
        bytes32 clientRef
    );
    event EvidenceSubmitted(uint256 indexed id, bytes32 indexed evidenceHash);
    event DisputeOpened(uint256 indexed id, address indexed by);
    event PaymentReleased(uint256 indexed id, uint256 providerPayout, uint256 protocolFee, address indexed by);
    event JobRefunded(uint256 indexed id, uint256 amount, address indexed by);
    event PolicySet(
        address indexed owner, address indexed agent, uint128 perJobCap, uint128 dailyCap, uint64 expiresAt
    );
    event PolicyRevoked(address indexed owner, address indexed agent);
    event ProviderAllowlistSet(address indexed owner, address indexed agent, address indexed provider, bool allowed);
    event ArbiterAllowlistSet(address indexed owner, address indexed agent, address indexed arbiter, bool allowed);

    constructor(address usdc_, address treasury_, uint16 feeBps_) {
        if (usdc_ == address(0) || treasury_ == address(0)) revert InvalidAddress();
        if (usdc_.code.length == 0) revert InvalidAddress();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidAmount();
        usdc = IERC20(usdc_);
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ───────────────────────────── views ─────────────────────────────

    function getJob(uint256 id) external view returns (Job memory) {
        return _jobs[id];
    }

    function dayIndex(uint256 timestamp) public pure returns (uint256) {
        return timestamp / 1 days;
    }

    function quote(uint256 amount) public view returns (uint256 providerPayout, uint256 protocolFee) {
        protocolFee = (amount * feeBps) / 10_000;
        providerPayout = amount - protocolFee;
    }

    // ───────────────────────── spend policies ─────────────────────────

    /// @notice Owner authorises `agent` to fund escrows from the owner's token allowance within limits.
    function setPolicy(address agent, uint128 perJobCap, uint128 dailyCap, uint64 expiresAt) external {
        if (agent == address(0) || agent == msg.sender) revert InvalidAddress();
        if (perJobCap == 0 || dailyCap < perJobCap) revert InvalidAmount();
        if (expiresAt <= block.timestamp) revert InvalidDeadline();
        policies[msg.sender][agent] = SpendPolicy(perJobCap, dailyCap, expiresAt, true);
        emit PolicySet(msg.sender, agent, perJobCap, dailyCap, expiresAt);
    }

    /// @notice Immediately stops the agent from funding new jobs. Existing jobs are unaffected.
    function revokePolicy(address agent) external {
        policies[msg.sender][agent].active = false;
        emit PolicyRevoked(msg.sender, agent);
    }

    function setProviderAllowed(address agent, address provider, bool allowed) external {
        if (provider == address(0)) revert InvalidAddress();
        providerAllowed[msg.sender][agent][provider] = allowed;
        emit ProviderAllowlistSet(msg.sender, agent, provider, allowed);
    }

    /// @notice Which arbiters `agent` may name on jobs it funds from the caller's allowance.
    function setArbiterAllowed(address agent, address arbiter, bool allowed) external {
        if (arbiter == address(0) || arbiter == msg.sender || arbiter == agent) revert InvalidAddress();
        arbiterAllowed[msg.sender][agent][arbiter] = allowed;
        emit ArbiterAllowlistSet(msg.sender, agent, arbiter, allowed);
    }

    // ─────────────────────────── funding ───────────────────────────

    function createJob(
        address provider,
        address arbiter,
        uint256 amount,
        uint64 deadline,
        bytes32 termsHash,
        bytes32 clientRef
    ) external nonReentrant returns (uint256 id) {
        id = _create(msg.sender, address(0), provider, arbiter, amount, deadline, termsHash, clientRef);
    }

    /// @notice Called by an agent key; funds are pulled from `owner`, who must have set a policy for msg.sender.
    function createJobAsAgent(
        address owner,
        address provider,
        address arbiter,
        uint256 amount,
        uint64 deadline,
        bytes32 termsHash,
        bytes32 clientRef
    ) external nonReentrant returns (uint256 id) {
        SpendPolicy memory p = policies[owner][msg.sender];
        if (!p.active || block.timestamp >= p.expiresAt) revert PolicyInactive();
        if (!providerAllowed[owner][msg.sender][provider]) revert ProviderNotAllowed();
        if (!arbiterAllowed[owner][msg.sender][arbiter]) revert ArbiterNotAllowed();
        if (amount > p.perJobCap) revert PerJobCapExceeded();
        uint256 day = dayIndex(block.timestamp);
        uint256 spent = spentPerDay[owner][msg.sender][day] + amount;
        if (spent > p.dailyCap) revert DailyCapExceeded();
        spentPerDay[owner][msg.sender][day] = spent;
        id = _create(owner, msg.sender, provider, arbiter, amount, deadline, termsHash, clientRef);
    }

    function _create(
        address buyer,
        address agent,
        address provider,
        address arbiter,
        uint256 amount,
        uint64 deadline,
        bytes32 termsHash,
        bytes32 clientRef
    ) internal returns (uint256 id) {
        if (provider == address(0) || provider == buyer || provider == agent) {
            revert InvalidAddress();
        }
        // The arbiter must be a third party: never a payer, payee or the buyer's agent.
        if (arbiter == address(0) || arbiter == buyer || arbiter == provider || arbiter == agent) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_DURATION) revert InvalidDeadline();
        if (termsHash == bytes32(0) || clientRef == bytes32(0)) revert InvalidCommitment();
        if (jobIdByRef[buyer][clientRef] != 0) revert DuplicateClientRef();

        // Effects before the external call; the whole tx reverts if the transfer fails or is short.
        id = ++nextId;
        jobIdByRef[buyer][clientRef] = id;
        _jobs[id] = Job({
            buyer: buyer,
            deadline: deadline,
            status: Status.Funded,
            provider: provider,
            agent: agent,
            arbiter: arbiter,
            amount: amount,
            termsHash: termsHash,
            evidenceHash: bytes32(0),
            clientRef: clientRef
        });
        emit JobCreated(id, buyer, provider, agent, arbiter, amount, deadline, termsHash, clientRef);

        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(buyer, address(this), amount);
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert FeeOnTransferNotSupported();
    }

    // ─────────────────────────── lifecycle ───────────────────────────

    function _isBuyerSide(Job storage job) internal view returns (bool) {
        return msg.sender == job.buyer || (job.agent != address(0) && msg.sender == job.agent);
    }

    /// @notice Provider submits immutable evidence hash; buyer must still approve quality.
    function deliver(uint256 id, bytes32 evidenceHash) external {
        Job storage job = _jobs[id];
        if (msg.sender != job.provider) revert Forbidden();
        if (job.status != Status.Funded) revert InvalidState();
        if (block.timestamp > job.deadline) revert DeadlinePassed();
        if (evidenceHash == bytes32(0)) revert InvalidCommitment();
        job.evidenceHash = evidenceHash;
        job.status = Status.Delivered;
        emit EvidenceSubmitted(id, evidenceHash);
    }

    function approve(uint256 id) external nonReentrant {
        Job storage job = _jobs[id];
        if (!_isBuyerSide(job)) revert Forbidden();
        if (job.status != Status.Delivered) revert InvalidState();
        _pay(id, job);
    }

    /// @notice A party can dispute a funded or delivered job; only the job's named arbiter decides.
    function dispute(uint256 id) external {
        Job storage job = _jobs[id];
        if (!_isBuyerSide(job) && msg.sender != job.provider) revert Forbidden();
        if (job.status != Status.Funded && job.status != Status.Delivered) revert InvalidState();
        job.status = Status.Disputed;
        emit DisputeOpened(id, msg.sender);
    }

    function resolve(uint256 id, bool payProvider) external nonReentrant {
        Job storage job = _jobs[id];
        if (job.arbiter == address(0) || msg.sender != job.arbiter) revert Forbidden();
        if (job.status != Status.Disputed) revert InvalidState();
        if (payProvider) _pay(id, job);
        else _refund(id, job);
    }

    /// @notice Buyer side can reclaim funds when the provider did not deliver before the deadline.
    function refundExpired(uint256 id) external nonReentrant {
        Job storage job = _jobs[id];
        if (!_isBuyerSide(job)) revert Forbidden();
        if (job.status != Status.Funded) revert InvalidState();
        if (block.timestamp <= job.deadline) revert DeadlineNotPassed();
        _refund(id, job);
    }

    /// @notice Provider may voluntarily refund an open job (including after delivery).
    function providerRefund(uint256 id) external nonReentrant {
        Job storage job = _jobs[id];
        if (msg.sender != job.provider) revert Forbidden();
        if (job.status != Status.Funded && job.status != Status.Delivered) revert InvalidState();
        _refund(id, job);
    }

    function _pay(uint256 id, Job storage job) internal {
        job.status = Status.Paid; // effects before interactions
        (uint256 payout, uint256 fee) = quote(job.amount);
        emit PaymentReleased(id, payout, fee, msg.sender);
        usdc.safeTransfer(job.provider, payout);
        if (fee != 0) usdc.safeTransfer(treasury, fee);
    }

    function _refund(uint256 id, Job storage job) internal {
        job.status = Status.Refunded;
        emit JobRefunded(id, job.amount, msg.sender);
        usdc.safeTransfer(job.buyer, job.amount);
    }
}
