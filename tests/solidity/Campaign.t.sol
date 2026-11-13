// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Support,Campaign,CampaignFactory,PredictionRegistry} from "./Support.sol";
import {RefundProbe} from "../contracts/RefundProbe.sol";
contract RejectEther { receive() external payable { revert("refuse ETH"); } }
contract CampaignTest is Support {
    event FundingStarted();
    event Contribution(address indexed backer,uint256 amount);
    event GoalReached(uint256 total);
    event ReportSubmitted(uint256 indexed milestone,bytes32 reportHash,uint64 voteDeadline);
    event VoteCast(uint256 indexed milestone,address indexed backer,bool support,uint256 weight);
    event MilestoneFinalized(uint256 indexed milestone,bool approved,uint256 amount);
    event RefundsOpened(uint256 pool);
    event RefundClaimed(address indexed backer,address indexed recipient,uint256 amount);
    event PayoutWithdrawn(address indexed recipient,uint256 amount);
    function testStartEvent() public { prediction();vm.expectEmit(false,false,false,true,address(c));emit FundingStarted();vm.prank(AUTHOR);c.startFunding(); }
    function testOnlyAuthorStarts() public { prediction();rejects(Campaign.Unauthorized.selector);c.startFunding(); }
    function testRequiresPrediction() public { rejects(Campaign.PredictionRequired.selector);vm.prank(AUTHOR);c.startFunding(); }
    function testStartLate() public { prediction();vm.warp(block.timestamp+3600);rejects(Campaign.TooLate.selector);vm.prank(AUTHOR);c.startFunding(); }
    function testStartTwice() public { start();rejects(Campaign.WrongState.selector);vm.prank(AUTHOR);c.startFunding(); }
    function testPausedStarts() public { prediction();r.setPaused(true);rejects(Campaign.SystemPaused.selector);vm.prank(AUTHOR);c.startFunding(); }
    function testResume() public { prediction();r.setPaused(true);r.setPaused(false);vm.prank(AUTHOR);c.startFunding();assert(c.state()==Campaign.State.Funding); }
    function testContributionEvent() public { start();vm.expectEmit(true,false,false,true,address(c));emit Contribution(A,1 ether);vm.prank(A);c.contribute{value:1 ether}(); }
    function testGoalEvent() public { start();vm.expectEmit(false,false,false,true,address(c));emit GoalReached(10 ether);vm.prank(A);c.contribute{value:10 ether}(); }
    function testAuthorCannotFund() public { start();rejects(Campaign.Unauthorized.selector);vm.prank(AUTHOR);c.contribute{value:1 ether}(); }
    function testZeroContribution() public { start();rejects(Campaign.InvalidInput.selector);vm.prank(A);c.contribute(); }
    function testOverfunding() public { start();rejects(Campaign.InvalidInput.selector);vm.prank(A);c.contribute{value:11 ether}(); }
    function testLateContribution() public { start();vm.warp(block.timestamp+3600);rejects(Campaign.TooLate.selector);vm.prank(A);c.contribute{value:1 ether}(); }
    function testPausedContribution() public { start();r.setPaused(true);rejects(Campaign.SystemPaused.selector);vm.prank(A);c.contribute{value:1 ether}(); }
    function testFinalizeFundingTooEarly() public { start();rejects(Campaign.TooEarly.selector);c.finalizeFunding(); }
    function testUnmetFundingRefundEvent() public { start();vm.prank(A);c.contribute{value:1 ether}();vm.warp(block.timestamp+3600);vm.expectEmit(false,false,false,true,address(c));emit RefundsOpened(1 ether);c.finalizeFunding();assert(c.refundPool()==1 ether); }
    function testCancelDraft() public { vm.prank(AUTHOR);c.cancelDraft();assert(c.state()==Campaign.State.Refunding); }
    function testCancelUnauthorized() public { rejects(Campaign.Unauthorized.selector);c.cancelDraft(); }
    function testCancelAfterStart() public { start();rejects(Campaign.WrongState.selector);vm.prank(AUTHOR);c.cancelDraft(); }
    function testReportEvent() public { funded();vm.expectEmit(true,false,false,true,address(c));emit ReportSubmitted(0,keccak256("report"),uint64(block.timestamp+60));report(); }
    function testEmptyReport() public { funded();rejects(Campaign.InvalidInput.selector);vm.prank(AUTHOR);c.submitReport(bytes32(0)); }
    function testForeignReport() public { funded();rejects(Campaign.Unauthorized.selector);c.submitReport(keccak256("x")); }
    function testLateReport() public { funded();vm.warp(block.timestamp+120);rejects(Campaign.TooLate.selector);report(); }
    function testReportTwice() public { funded();report();rejects(Campaign.WrongState.selector);report(); }
    function testVoteEvent() public { funded();report();vm.expectEmit(true,true,false,true,address(c));emit VoteCast(0,A,true,6 ether);vm.prank(A);c.vote(true);assert(c.hasVoted(0,A)); }
    function testForeignVote() public { funded();report();rejects(Campaign.Unauthorized.selector);c.vote(true); }
    function testVoteTwice() public { funded();report();vm.prank(A);c.vote(true);rejects(Campaign.AlreadyVoted.selector);vm.prank(A);c.vote(false); }
    function testLateVote() public { funded();report();vm.warp(block.timestamp+60);rejects(Campaign.TooLate.selector);vm.prank(A);c.vote(false); }
    function testFinalizeVoteTooEarly() public { funded();report();rejects(Campaign.TooEarly.selector);c.finalizeMilestone(); }
    function testApproveEvent() public { funded();report();vm.prank(A);c.vote(true);vm.warp(block.timestamp+60);vm.expectEmit(true,false,false,true,address(c));emit MilestoneFinalized(0,true,4 ether);c.finalizeMilestone();assert(c.authorCredit()==4 ether); }
    function testRejectRefunds() public { funded();report();vm.prank(A);c.vote(false);vm.warp(block.timestamp+60);c.finalizeMilestone();assert(c.refundPool()==10 ether); }
    function testNoQuorumRefunds() public { funded();report();vm.prank(B);c.vote(true);vm.warp(block.timestamp+60);c.finalizeMilestone();assert(c.state()==Campaign.State.Refunding); }
    function testNoVotesRefunds() public { funded();report();vm.warp(block.timestamp+60);c.finalizeMilestone();assert(c.refundPool()==10 ether); }
    function testMissedReportDeadline() public { funded();vm.warp(block.timestamp+120);c.expireSubmission();assert(c.refundPool()==10 ether); }
    function testExpireTooEarly() public { funded();rejects(Campaign.TooEarly.selector);c.expireSubmission(); }
    function testPayoutEvent() public { funded();approve();vm.expectEmit(true,false,false,true,address(c));emit PayoutWithdrawn(OTHER,4 ether);vm.prank(AUTHOR);c.withdrawPayout(payable(OTHER));assert(OTHER.balance==4 ether); }
    function testForeignPayout() public { funded();approve();rejects(Campaign.Unauthorized.selector);c.withdrawPayout(payable(OTHER)); }
    function testZeroPayoutRecipient() public { funded();approve();rejects(Campaign.InvalidInput.selector);vm.prank(AUTHOR);c.withdrawPayout(payable(address(0))); }
    function testPayoutTwice() public { funded();approve();vm.prank(AUTHOR);c.withdrawPayout(payable(OTHER));rejects(Campaign.NothingToWithdraw.selector);vm.prank(AUTHOR);c.withdrawPayout(payable(OTHER)); }
    function testAllMilestonesComplete() public { funded();approve();approve();assert(c.state()==Campaign.State.Completed);assert(c.authorCredit()==10 ether); }
    function testRefundEvent() public { funded();approve();vm.warp(block.timestamp+120);c.expireSubmission();vm.expectEmit(true,true,false,true,address(c));emit RefundClaimed(A,OTHER,3.6 ether);vm.prank(A);c.claimRefund(payable(OTHER));assert(OTHER.balance==3.6 ether); }
    function testForeignRefund() public { funded();vm.warp(block.timestamp+120);c.expireSubmission();rejects(Campaign.NothingToWithdraw.selector);c.claimRefund(payable(OTHER)); }
    function testZeroRefundRecipient() public { funded();vm.warp(block.timestamp+120);c.expireSubmission();rejects(Campaign.InvalidInput.selector);vm.prank(A);c.claimRefund(payable(address(0))); }
    function testRefundTwice() public { funded();vm.warp(block.timestamp+120);c.expireSubmission();vm.prank(A);c.claimRefund(payable(A));rejects(Campaign.NothingToWithdraw.selector);vm.prank(A);c.claimRefund(payable(A)); }
    function testRefundStateGuard() public { funded();rejects(Campaign.WrongState.selector);vm.prank(A);c.claimRefund(payable(A)); }
    function testRefundableNonBackerAndClaimed() public { funded();assert(c.refundable(A)==0);vm.warp(block.timestamp+120);c.expireSubmission();assert(c.refundable(OTHER)==0);vm.prank(A);c.claimRefund(payable(A));assert(c.refundable(A)==0); }
    function testBitmapOutOfRange() public view { assert(!c.hasVoted(256,A));assert(!c.hasVoted(0,A)); }
    function testPausedExit() public { funded();r.setPaused(true);vm.warp(block.timestamp+120);rejects(Campaign.SystemPaused.selector);c.expireSubmission();r.setPaused(false);c.expireSubmission(); }
    function testPayoutTransferFailurePreservesCredit() public {
        funded();approve();RejectEther rejector=new RejectEther();rejects(Campaign.TransferFailed.selector);
        vm.prank(AUTHOR);c.withdrawPayout(payable(address(rejector)));assert(c.authorCredit()==4 ether);
    }
    function testRefundTransferFailurePreservesClaim() public {
        funded();vm.warp(block.timestamp+120);c.expireSubmission();RejectEther rejector=new RejectEther();
        rejects(Campaign.TransferFailed.selector);vm.prank(A);c.claimRefund(payable(address(rejector)));assert(!c.refundClaimed(A));assert(c.refundable(A)==6 ether);
    }
    function testRefundReentryRejected() public {
        start();RefundProbe attacker=new RefundProbe();vm.deal(address(this),4 ether);
        attacker.fund{value:4 ether}(address(c));vm.prank(A);c.contribute{value:6 ether}();vm.warp(block.timestamp+120);c.expireSubmission();
        attacker.claim(true,false);assert(!attacker.nestedSucceeded());assert(address(attacker).balance==4 ether);assert(c.totalRefunded()==4 ether);
    }
    function testMaximumGoalQuorumDoesNotOverflowPackedWeights() public {
        uint256 goal=type(uint128).max;c=create(goal,4000,6000);start();vm.deal(A,goal);
        vm.prank(A);c.contribute{value:goal}();report();vm.prank(A);c.vote(true);vm.warp(block.timestamp+60);c.finalizeMilestone();
        assert(c.authorCredit()==goal*4000/10000);assert(c.state()==Campaign.State.Funded);
    }
    function testFuzzRefundConservation(uint96 rawGoal,uint96 rawA) public {
        uint256 goal=uint256(rawGoal)%20 ether+100;
        uint256 part=uint256(rawA)%(goal-1)+1;
        c=create(goal,4000,6000);start();vm.prank(A);c.contribute{value:part}();vm.prank(B);c.contribute{value:goal-part}();approve();
        vm.warp(block.timestamp+120);c.expireSubmission();uint256 pool=c.refundPool();
        vm.prank(A);c.claimRefund(payable(A));vm.prank(B);c.claimRefund(payable(B));
        assert(c.totalRefunded()==pool);assert(c.totalReleased()+c.totalRefunded()==goal);assert(address(c).balance==c.authorCredit());
    }
}
