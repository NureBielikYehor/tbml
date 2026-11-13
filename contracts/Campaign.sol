// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PredictionRegistry} from "./PredictionRegistry.sol";

contract Campaign is ReentrancyGuard {
    enum State { Draft, Funding, Funded, Voting, Completed, Refunding }
    enum MilestoneStatus { Pending, Voting, Approved, Rejected }
    struct Milestone {
        uint128 amount;
        uint64 voteDeadline;
        MilestoneStatus status;
        uint128 yesWeight;
        uint128 noWeight;
        bytes32 reportHash;
    }

    /// @notice Immutable campaign author.
    address public immutable author;
    /// @notice The trusted factory address.
    address public immutable factory;
    /// @notice Registry used for predictions and the global emergency pause.
    PredictionRegistry public immutable registry;
    /// @notice Hash of canonical campaign metadata stored off chain.
    bytes32 public immutable metadataHash;
    /// @notice Immutable funding target in wei, bounded by uint128.
    uint256 public immutable goal;
    /// @notice Last contribution deadline in Unix seconds.
    uint64 public immutable fundingDeadline;
    /// @notice Voting period length in seconds.
    uint64 public immutable votingDuration;
    /// @notice Time allowed for each report in seconds.
    uint64 public immutable submissionWindow;
    /// @notice Current lifecycle state; only defined transitions are permitted.
    State public state;
    /// @notice Total contributions accepted in wei.
    uint256 public totalContributed;
    /// @notice Approved tranche total, including author credit not yet withdrawn.
    uint256 public totalReleased;
    /// @notice Approved but unwithdrawn author credit in wei.
    uint256 public authorCredit;
    /// @notice Index of the active or next milestone.
    uint256 public currentMilestone;
    /// @notice Current milestone report deadline in Unix seconds.
    uint64 public submissionDeadline;
    /// @notice Fixed amount reserved for pro-rata refunds after failure.
    uint256 public refundPool;
    /// @notice Total refunds already withdrawn in wei.
    uint256 public totalRefunded;
    /// @notice Remaining original contribution weight for rounding reconciliation.
    uint256 public unclaimedWeight;
    /// @notice Milestone allocations, deadlines, vote totals, status and report hashes.
    Milestone[] public milestones;
    /// @notice Original accepted contribution weight per backer.
    mapping(address => uint256) public contributions;
    mapping(address => uint256) private _voteBitmap;
    /// @notice Whether a backer has already withdrawn its refund.
    mapping(address => bool) public refundClaimed;

    error SystemPaused();
    error Unauthorized();
    error WrongState();
    error InvalidInput();
    error TooEarly();
    error TooLate();
    error AlreadyVoted();
    error NothingToWithdraw();
    error TransferFailed();
    error PredictionRequired();
    event FundingStarted();
    event Contribution(address indexed backer, uint256 amount);
    event GoalReached(uint256 total);
    event ReportSubmitted(uint256 indexed milestone, bytes32 reportHash, uint64 voteDeadline);
    event VoteCast(uint256 indexed milestone, address indexed backer, bool support, uint256 weight);
    event MilestoneFinalized(uint256 indexed milestone, bool approved, uint256 amount);
    event PayoutWithdrawn(address indexed recipient, uint256 amount);
    event RefundsOpened(uint256 pool);
    event RefundClaimed(address indexed backer, address indexed recipient, uint256 amount);

    modifier whenActive() { if (registry.paused()) revert SystemPaused(); _; }
    modifier onlyAuthor() { if (msg.sender != author) revert Unauthorized(); _; }
    modifier inState(State expected) { if (state != expected) revert WrongState(); _; }

    /// @notice Initialize validated contract configuration and immutable dependencies.
    constructor(address author_, address registry_, bytes32 metadataHash_, uint256 goal_,
                uint64 fundingDeadline_, uint64 votingDuration_, uint64 submissionWindow_,
                uint16[] memory milestoneBps) {
        if (author_ == address(0) || registry_.code.length == 0 || metadataHash_ == bytes32(0) ||
            goal_ == 0 || goal_ > type(uint128).max || fundingDeadline_ <= block.timestamp ||
            fundingDeadline_ > block.timestamp + 90 days || votingDuration_ < 60 ||
            votingDuration_ > 30 days || submissionWindow_ < 60 || submissionWindow_ > 90 days ||
            milestoneBps.length == 0 || milestoneBps.length > 20) revert InvalidInput();
        author = author_; factory = msg.sender; registry = PredictionRegistry(registry_);
        metadataHash = metadataHash_; goal = goal_; fundingDeadline = fundingDeadline_;
        votingDuration = votingDuration_; submissionWindow = submissionWindow_;
        uint256 sum = 0;
        for (uint256 i; i < milestoneBps.length; i++) sum += milestoneBps[i];
        if (sum != 10000) revert InvalidInput();
        uint256 allocated = 0;
        for (uint256 i; i < milestoneBps.length; i++) {
            if (milestoneBps[i] == 0) revert InvalidInput();
            uint256 amount = i + 1 == milestoneBps.length ? goal_ - allocated :
                             Math.mulDiv(goal_, milestoneBps[i], 10000);
            if (amount == 0) revert InvalidInput();
            allocated += amount;
            milestones.push(Milestone(uint128(amount), 0, MilestoneStatus.Pending, 0, 0, bytes32(0)));
        }
    }

    /// @notice Whether an address has cast a vote for a milestone (at most twenty bits).
    function hasVoted(uint256 index, address backer) public view returns (bool) {
        return index < milestones.length && (_voteBitmap[backer] & (uint256(1) << index)) != 0;
    }

    /// @notice Return the number of milestone allocations.
    function milestoneCount() external view returns (uint256) { return milestones.length; }

    /// @notice Open contributions after a valid prediction; only the author of a draft may call.
    function startFunding() external whenActive onlyAuthor inState(State.Draft) {
        if (block.timestamp >= fundingDeadline) revert TooLate();
        if (!registry.hasValidPrediction(address(this))) revert PredictionRequired();
        state = State.Funding;
        emit FundingStarted();
    }

    /// @notice Record a nonzero contribution up to the remaining goal; the author cannot contribute.
    function contribute() external payable whenActive inState(State.Funding) {
        if (msg.sender == author) revert Unauthorized();
        if (block.timestamp >= fundingDeadline) revert TooLate();
        if (msg.value == 0 || msg.value > goal - totalContributed) revert InvalidInput();
        contributions[msg.sender] += msg.value;
        totalContributed += msg.value;
        emit Contribution(msg.sender, msg.value);
        if (totalContributed == goal) {
            state = State.Funded;
            submissionDeadline = uint64(block.timestamp) + submissionWindow;
            emit GoalReached(totalContributed);
        }
    }

    /// @notice After the funding deadline, allow anyone to open refunds for an unmet goal.
    function finalizeFunding() external whenActive inState(State.Funding) {
        if (block.timestamp < fundingDeadline) revert TooEarly();
        _openRefunds();
    }

    /// @notice Cancel an unlaunched draft; author only.
    function cancelDraft() external whenActive onlyAuthor inState(State.Draft) { _openRefunds(); }

    /// @notice Commit the off-chain report hash and open milestone voting; author only before deadline.
    function submitReport(bytes32 reportHash) external whenActive onlyAuthor inState(State.Funded) {
        if (block.timestamp >= submissionDeadline) revert TooLate();
        if (reportHash == bytes32(0)) revert InvalidInput();
        Milestone storage m = milestones[currentMilestone];
        m.reportHash = reportHash;
        m.voteDeadline = uint64(block.timestamp) + votingDuration;
        m.status = MilestoneStatus.Voting;
        state = State.Voting;
        emit ReportSubmitted(currentMilestone, reportHash, m.voteDeadline);
    }

    /// @notice Record one contribution-weighted vote per milestone before the voting deadline.
    function vote(bool support) external whenActive inState(State.Voting) {
        Milestone storage m = milestones[currentMilestone];
        if (block.timestamp >= m.voteDeadline) revert TooLate();
        uint256 weight = contributions[msg.sender];
        if (weight == 0) revert Unauthorized();
        if (hasVoted(currentMilestone, msg.sender)) revert AlreadyVoted();
        _voteBitmap[msg.sender] |= uint256(1) << currentMilestone;
        if (support) m.yesWeight += uint128(weight); else m.noWeight += uint128(weight);
        emit VoteCast(currentMilestone, msg.sender, support, weight);
    }

    /// @notice After voting ends, credit an approved tranche or open refunds on rejection.
    function finalizeMilestone() external whenActive inState(State.Voting) {
        Milestone storage m = milestones[currentMilestone];
        if (block.timestamp < m.voteDeadline) revert TooEarly();
        bool approved = (uint256(m.yesWeight) + m.noWeight) * 2 >= totalContributed && m.yesWeight > m.noWeight;
        m.status = approved ? MilestoneStatus.Approved : MilestoneStatus.Rejected;
        emit MilestoneFinalized(currentMilestone, approved, approved ? m.amount : 0);
        if (!approved) { _openRefunds(); return; }
        totalReleased += m.amount;
        authorCredit += m.amount;
        currentMilestone++;
        if (currentMilestone == milestones.length) state = State.Completed;
        else {
            state = State.Funded;
            submissionDeadline = uint64(block.timestamp) + submissionWindow;
        }
    }

    /// @notice Allow anyone to open refunds after a missed report deadline.
    function expireSubmission() external whenActive inState(State.Funded) {
        if (block.timestamp < submissionDeadline) revert TooEarly();
        _openRefunds();
    }

    /// @notice Withdraw approved author credit to a nonzero recipient; author only, guarded against reentry.
    function withdrawPayout(address payable recipient) external whenActive onlyAuthor nonReentrant {
        uint256 amount = authorCredit;
        if (amount == 0) revert NothingToWithdraw();
        if (recipient == address(0)) revert InvalidInput();
        authorCredit = 0;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PayoutWithdrawn(recipient, amount);
    }

    /// @notice Return the remaining pro-rata refund, assigning rounding dust to the last claimant.
    function refundable(address backer) public view returns (uint256) {
        uint256 weight = contributions[backer];
        if (state != State.Refunding || weight == 0 || refundClaimed[backer]) return 0;
        if (weight == unclaimedWeight) return refundPool - totalRefunded;
        return Math.mulDiv(refundPool, weight, totalContributed);
    }

    /// @notice Withdraw the caller's unclaimed share to a nonzero recipient; guarded against reentry.
    function claimRefund(address payable recipient) external whenActive inState(State.Refunding) nonReentrant {
        uint256 weight = contributions[msg.sender];
        if (weight == 0 || refundClaimed[msg.sender]) revert NothingToWithdraw();
        if (recipient == address(0)) revert InvalidInput();
        uint256 amount = refundable(msg.sender);
        refundClaimed[msg.sender] = true;
        unclaimedWeight -= weight;
        totalRefunded += amount;
        if (amount != 0) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
        emit RefundClaimed(msg.sender, recipient, amount);
    }

    /// @notice Return the campaign state or committed metadata hash.
    function _openRefunds() private {
        state = State.Refunding;
        refundPool = totalContributed - totalReleased;
        unclaimedWeight = totalContributed;
        emit RefundsOpened(refundPool);
    }
}
