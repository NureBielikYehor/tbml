// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PredictionRegistry} from "./PredictionRegistry.sol";

contract Campaign is ReentrancyGuard {
    enum State { Draft, Funding, Funded, Voting, Completed, Refunding }
    enum MilestoneStatus { Pending, Voting, Approved, Rejected }
    struct Milestone {
        uint256 amount;
        bytes32 reportHash;
        uint64 voteDeadline;
        uint256 yesWeight;
        uint256 noWeight;
        MilestoneStatus status;
    }

    address public immutable author;
    address public immutable factory;
    PredictionRegistry public immutable registry;
    bytes32 public immutable metadataHash;
    uint256 public immutable goal;
    uint64 public immutable fundingDeadline;
    uint64 public immutable votingDuration;
    uint64 public immutable submissionWindow;
    State public state;
    uint256 public totalContributed;
    uint256 public totalReleased;
    uint256 public authorCredit;
    uint256 public currentMilestone;
    uint64 public submissionDeadline;
    uint256 public refundPool;
    uint256 public totalRefunded;
    uint256 public unclaimedWeight;
    Milestone[] public milestones;
    mapping(address => uint256) public contributions;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(address => bool) public refundClaimed;

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

    modifier onlyAuthor() { if (msg.sender != author) revert Unauthorized(); _; }
    modifier inState(State expected) { if (state != expected) revert WrongState(); _; }

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
        uint256 sum; uint256 allocated;
        for (uint256 i; i < milestoneBps.length; i++) {
            if (milestoneBps[i] == 0) revert InvalidInput();
            sum += milestoneBps[i];
            uint256 amount = i + 1 == milestoneBps.length ? goal_ - allocated :
                             Math.mulDiv(goal_, milestoneBps[i], 10000);
            if (amount == 0) revert InvalidInput();
            allocated += amount;
            milestones.push(Milestone(amount, bytes32(0), 0, 0, 0, MilestoneStatus.Pending));
        }
        if (sum != 10000) revert InvalidInput();
    }

    function milestoneCount() external view returns (uint256) { return milestones.length; }

    function startFunding() external onlyAuthor inState(State.Draft) {
        if (block.timestamp >= fundingDeadline) revert TooLate();
        if (!registry.hasValidPrediction(address(this))) revert PredictionRequired();
        state = State.Funding;
        emit FundingStarted();
    }

    function contribute() external payable inState(State.Funding) {
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

    function finalizeFunding() external inState(State.Funding) {
        if (block.timestamp < fundingDeadline) revert TooEarly();
        _openRefunds();
    }

    function cancelDraft() external onlyAuthor inState(State.Draft) { _openRefunds(); }

    function submitReport(bytes32 reportHash) external onlyAuthor inState(State.Funded) {
        if (block.timestamp >= submissionDeadline) revert TooLate();
        if (reportHash == bytes32(0)) revert InvalidInput();
        Milestone storage m = milestones[currentMilestone];
        m.reportHash = reportHash;
        m.voteDeadline = uint64(block.timestamp) + votingDuration;
        m.status = MilestoneStatus.Voting;
        state = State.Voting;
        emit ReportSubmitted(currentMilestone, reportHash, m.voteDeadline);
    }

    function vote(bool support) external inState(State.Voting) {
        Milestone storage m = milestones[currentMilestone];
        if (block.timestamp >= m.voteDeadline) revert TooLate();
        uint256 weight = contributions[msg.sender];
        if (weight == 0) revert Unauthorized();
        if (hasVoted[currentMilestone][msg.sender]) revert AlreadyVoted();
        hasVoted[currentMilestone][msg.sender] = true;
        if (support) m.yesWeight += weight; else m.noWeight += weight;
        emit VoteCast(currentMilestone, msg.sender, support, weight);
    }

    function finalizeMilestone() external inState(State.Voting) {
        Milestone storage m = milestones[currentMilestone];
        if (block.timestamp < m.voteDeadline) revert TooEarly();
        bool approved = (m.yesWeight + m.noWeight) * 2 >= totalContributed && m.yesWeight > m.noWeight;
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

    function expireSubmission() external inState(State.Funded) {
        if (block.timestamp < submissionDeadline) revert TooEarly();
        _openRefunds();
    }

    function withdrawPayout(address payable recipient) external onlyAuthor nonReentrant {
        uint256 amount = authorCredit;
        if (amount == 0) revert NothingToWithdraw();
        if (recipient == address(0)) revert InvalidInput();
        authorCredit = 0;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PayoutWithdrawn(recipient, amount);
    }

    function refundable(address backer) public view returns (uint256) {
        uint256 weight = contributions[backer];
        if (state != State.Refunding || weight == 0 || refundClaimed[backer]) return 0;
        if (weight == unclaimedWeight) return refundPool - totalRefunded;
        return Math.mulDiv(refundPool, weight, totalContributed);
    }

    function claimRefund(address payable recipient) external inState(State.Refunding) nonReentrant {
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

    function _openRefunds() private {
        state = State.Refunding;
        refundPool = totalContributed - totalReleased;
        unclaimedWeight = totalContributed;
        emit RefundsOpened(refundPool);
    }
}
