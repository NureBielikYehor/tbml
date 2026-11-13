// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Support,Vm,Campaign,CampaignFactory,PredictionRegistry} from "./Support.sol";
contract CampaignHandler {
    Vm constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Campaign public c;
    address constant A=address(102);address constant B=address(103);
    constructor(CampaignFactory f,PredictionRegistry r,bytes32 model) {
        uint16[] memory bps=new uint16[](2);bps[0]=4000;bps[1]=6000;
        bytes32 hash=keccak256("invariant-input");
        c=Campaign(f.createCampaign(hash,10 ether,uint64(block.timestamp+3600),60,120,bps));
        vm.prank(address(104));r.publishPrediction(address(c),7500,hash,model,keccak256("invariant-audit"),uint64(block.timestamp+3600));
        c.startFunding();vm.deal(A,100 ether);vm.deal(B,100 ether);
    }
    function contribute(uint256 who,uint256 amount) external {
        if(c.state()!=Campaign.State.Funding || block.timestamp>=c.fundingDeadline())return;
        uint256 remaining=c.goal()-c.totalContributed();amount=amount%remaining+1;
        address backer=who%2==0?A:B;vm.prank(backer);c.contribute{value:amount}();
    }
    function report() external {
        if(c.state()==Campaign.State.Funded && block.timestamp<c.submissionDeadline()) c.submitReport(keccak256("report"));
    }
    function vote(uint256 who,bool support) external {
        if(c.state()!=Campaign.State.Voting)return;
        (,uint64 end,,,,)=c.milestones(c.currentMilestone());
        address backer=who%2==0?A:B;
        if(block.timestamp>=end || c.contributions(backer)==0 || c.hasVoted(c.currentMilestone(),backer))return;
        vm.prank(backer);c.vote(support);
    }
    function advance(uint256 seconds_) external { vm.warp(block.timestamp+seconds_%180+1); }
    function finalize() external {
        if(c.state()==Campaign.State.Funding && block.timestamp>=c.fundingDeadline())c.finalizeFunding();
        else if(c.state()==Campaign.State.Funded && block.timestamp>=c.submissionDeadline())c.expireSubmission();
        else if(c.state()==Campaign.State.Voting) {
            (,uint64 end,,,,)=c.milestones(c.currentMilestone());
            if(block.timestamp>=end)c.finalizeMilestone();
        }
    }
    function withdraw(uint256 who) external {
        if(c.authorCredit()>0)c.withdrawPayout(payable(address(999)));
        address backer=who%2==0?A:B;
        if(c.state()==Campaign.State.Refunding && c.contributions(backer)>0 && !c.refundClaimed(backer)) {
            vm.prank(backer);c.claimRefund(payable(backer));
        }
    }
}
contract InvariantTest is Support {
    CampaignHandler internal handler;
    address[] internal targets;
    function setUp() public override {
        super.setUp();handler=new CampaignHandler(f,r,MODEL);c=handler.c();targets.push(address(handler));
    }
    function targetContracts() external view returns(address[] memory) {return targets;}
    // Foundry targeting ABI: empty lists mean no additional filters.
    struct SelectorTarget { address addr; bytes4[] selectors; }
    struct ArtifactSelector { string artifact; bytes4[] selectors; }
    struct InterfaceTarget { address addr; string[] artifacts; }
    function excludeContracts() external pure returns(address[] memory) { return new address[](0); }
    function targetSenders() external pure returns(address[] memory) { return new address[](0); }
    function excludeSenders() external pure returns(address[] memory) { return new address[](0); }
    function targetArtifacts() external pure returns(string[] memory) { return new string[](0); }
    function excludeArtifacts() external pure returns(string[] memory) { return new string[](0); }
    function targetArtifactSelectors() external pure returns(ArtifactSelector[] memory) { return new ArtifactSelector[](0); }
    function targetSelectors() external pure returns(SelectorTarget[] memory) { return new SelectorTarget[](0); }
    function excludeSelectors() external pure returns(SelectorTarget[] memory) { return new SelectorTarget[](0); }
    function targetInterfaces() external pure returns(InterfaceTarget[] memory) { return new InterfaceTarget[](0); }
    function invariantEscrowConservation() public view {
        // Released means approved; unwithdrawn credit remains in escrow.
        assert(address(c).balance==c.totalContributed()-c.totalReleased()+c.authorCredit()-c.totalRefunded());
    }
    function invariantLiabilitiesBounded() public view {
        assert(c.totalReleased()<=c.totalContributed());assert(c.totalRefunded()<=c.refundPool());
        if(c.state()==Campaign.State.Refunding)assert(c.refundPool()+c.totalReleased()==c.totalContributed());
        assert(c.currentMilestone()<=c.milestoneCount());
    }
    function invariantVotingWeightBounded() public view {
        for(uint256 i;i<c.milestoneCount();i++) {
            (,,,uint128 yes,uint128 no,)=c.milestones(i);
            assert(uint256(yes)+no<=c.totalContributed());
        }
    }
}
