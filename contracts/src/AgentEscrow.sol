// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AgentEscrow
 * @notice Testnet research prototype: buyer-funded escrow for agent-delivered work.
 * @dev Not audited. No autonomous validator, wallet policy, or production custody controls.
 *      A single arbiter can resolve disputes; this is a deliberate MVP trust assumption.
 *      Use only a non-fee-on-transfer six-decimal USDC-compatible token.
 */
contract AgentEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { None, Funded, Delivered, Disputed, Paid, Refunded }

    struct Job {
        address buyer;
        address provider;
        uint256 amount;
        uint64 deadline;
        bytes32 termsHash;
        bytes32 evidenceHash;
        Status status;
    }

    IERC20 public immutable usdc;
    address public immutable treasury;
    address public immutable arbiter;
    uint16 public immutable feeBps;
    uint256 public nextId;
    mapping(uint256 => Job) public jobs;

    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error InvalidCommitment();
    error Forbidden();
    error InvalidState();
    error DeadlineNotPassed();
    error DeadlinePassed();
    error FeeOnTransferNotSupported();

    event JobCreated(uint256 indexed id, address indexed buyer, address indexed provider, uint256 amount, uint64 deadline, bytes32 termsHash);
    event EvidenceSubmitted(uint256 indexed id, bytes32 indexed evidenceHash);
    event DisputeOpened(uint256 indexed id, address indexed by);
    event PaymentReleased(uint256 indexed id, uint256 providerPayout, uint256 protocolFee);
    event JobRefunded(uint256 indexed id);

    modifier onlyBuyer(uint256 id) {
        if (msg.sender != jobs[id].buyer) revert Forbidden();
        _;
    }

    modifier onlyProvider(uint256 id) {
        if (msg.sender != jobs[id].provider) revert Forbidden();
        _;
    }

    constructor(address usdc_, address treasury_, address arbiter_, uint16 feeBps_) {
        if (usdc_ == address(0) || treasury_ == address(0) || arbiter_ == address(0)) revert InvalidAddress();
        if (feeBps_ > 1000) revert InvalidAmount(); // at most 10%
        usdc = IERC20(usdc_);
        treasury = treasury_;
        arbiter = arbiter_;
        feeBps = feeBps_;
    }

    function createJob(address provider, uint256 amount, uint64 deadline, bytes32 termsHash)
        external nonReentrant returns (uint256 id)
    {
        if (provider == address(0) || provider == msg.sender) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (termsHash == bytes32(0)) revert InvalidCommitment();
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert FeeOnTransferNotSupported();
        id = ++nextId;
        jobs[id] = Job({
            buyer: msg.sender, provider: provider, amount: amount, deadline: deadline,
            termsHash: termsHash, evidenceHash: bytes32(0), status: Status.Funded
        });
        emit JobCreated(id, msg.sender, provider, amount, deadline, termsHash);
    }

    /** @notice Provider submits immutable evidence hash; buyer must still approve quality. */
    function deliver(uint256 id, bytes32 evidenceHash) external onlyProvider(id) {
        Job storage job = jobs[id];
        if (job.status != Status.Funded) revert InvalidState();
        if (block.timestamp > job.deadline) revert DeadlinePassed();
        if (evidenceHash == bytes32(0)) revert InvalidCommitment();
        job.evidenceHash = evidenceHash;
        job.status = Status.Delivered;
        emit EvidenceSubmitted(id, evidenceHash);
    }

    function approve(uint256 id) external nonReentrant onlyBuyer(id) {
        Job storage job = jobs[id];
        if (job.status != Status.Delivered) revert InvalidState();
        _pay(id, job);
    }

    /** @notice A party can dispute a funded or delivered job; only named arbiter decides. */
    function dispute(uint256 id) external {
        Job storage job = jobs[id];
        if (msg.sender != job.buyer && msg.sender != job.provider) revert Forbidden();
        if (job.status != Status.Funded && job.status != Status.Delivered) revert InvalidState();
        job.status = Status.Disputed;
        emit DisputeOpened(id, msg.sender);
    }

    function resolve(uint256 id, bool payProvider) external nonReentrant {
        if (msg.sender != arbiter) revert Forbidden();
        Job storage job = jobs[id];
        if (job.status != Status.Disputed) revert InvalidState();
        if (payProvider) _pay(id, job);
        else _refund(id, job);
    }

    /** @notice Buyer can reclaim funds when provider did not deliver before deadline. */
    function refundExpired(uint256 id) external nonReentrant onlyBuyer(id) {
        Job storage job = jobs[id];
        if (job.status != Status.Funded) revert InvalidState();
        if (block.timestamp <= job.deadline) revert DeadlineNotPassed();
        _refund(id, job);
    }

    /** @notice Provider may voluntarily refund an open job (including after delivery). */
    function providerRefund(uint256 id) external nonReentrant onlyProvider(id) {
        Job storage job = jobs[id];
        if (job.status != Status.Funded && job.status != Status.Delivered) revert InvalidState();
        _refund(id, job);
    }

    function _pay(uint256 id, Job storage job) internal {
        job.status = Status.Paid; // effects before interactions
        uint256 fee = (job.amount * feeBps) / 10_000;
        uint256 payout = job.amount - fee;
        usdc.safeTransfer(job.provider, payout);
        if (fee != 0) usdc.safeTransfer(treasury, fee);
        emit PaymentReleased(id, payout, fee);
    }

    function _refund(uint256 id, Job storage job) internal {
        job.status = Status.Refunded;
        usdc.safeTransfer(job.buyer, job.amount);
        emit JobRefunded(id);
    }
}
