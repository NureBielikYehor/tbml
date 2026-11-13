// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Support,Campaign,CampaignFactory,PredictionRegistry} from "./Support.sol";
contract RegistryTest is Support {
    event PauseChanged(bool paused);
    event OracleSet(address indexed oracle,bool enabled);
    event OracleRotated(address indexed previous,address indexed replacement);
    event PredictionPublished(address indexed campaign,uint16 scoreBps,bytes32 indexed modelHash,bytes32 inputHash,bytes32 auditHash,uint64 expiresAt);
    event CampaignCreated(address indexed campaign,address indexed author,bytes32 metadataHash);
    function testPredictionEventAndFields() public {
        vm.expectEmit(true,true,false,true,address(r));emit PredictionPublished(address(c),7200,MODEL,META,AUDIT,uint64(block.timestamp+1000));prediction();
        (uint16 score,bytes32 input,bytes32 model,bytes32 audit,uint64 published,uint64 until)=r.predictions(address(c));
        assert(score==7200 && input==META && model==MODEL && audit==AUDIT && published==block.timestamp && until==block.timestamp+1000);
    }
    function testPredictionUnknownOracle() public { rejects(PredictionRegistry.Unauthorized.selector);r.publishPrediction(address(c),7200,META,MODEL,AUDIT,uint64(block.timestamp+60)); }
    function testOracleRotationEventsAndRevocation() public {
        vm.expectEmit(true,true,false,true,address(r));emit OracleRotated(ORACLE,OTHER);r.rotateOracle(ORACLE,OTHER);
        assert(!r.oracles(ORACLE)&&r.oracles(OTHER));rejects(PredictionRegistry.Unauthorized.selector);prediction();
        vm.prank(OTHER);r.publishPrediction(address(c),7200,META,MODEL,AUDIT,uint64(block.timestamp+60));assert(r.hasValidPrediction(address(c)));
    }
    function testRotationUnauthorized() public { vm.expectRevert();vm.prank(OTHER);r.rotateOracle(ORACLE,OTHER); }
    function testRotationUnknownOld() public { rejects(PredictionRegistry.InvalidInput.selector);r.rotateOracle(A,OTHER); }
    function testRotationSame() public { rejects(PredictionRegistry.InvalidInput.selector);r.rotateOracle(ORACLE,ORACLE); }
    function testRotationZero() public { rejects(PredictionRegistry.InvalidInput.selector);r.rotateOracle(ORACLE,address(0)); }
    function testPauseEvent() public { vm.expectEmit(false,false,false,true,address(r));emit PauseChanged(true);r.setPaused(true);assert(r.paused()); }
    function testPauseUnauthorized() public { vm.expectRevert();vm.prank(A);r.setPaused(true); }
    function testPausePublication() public { r.setPaused(true);rejects(PredictionRegistry.SystemPaused.selector);prediction(); }
    function testSetOracleZero() public { rejects(PredictionRegistry.InvalidInput.selector);r.setOracle(address(0),true); }
    function testSetOracleEvent() public { vm.expectEmit(true,false,false,true,address(r));emit OracleSet(OTHER,true);r.setOracle(OTHER,true); }
    function testDisableOracle() public { r.setOracle(ORACLE,false);rejects(PredictionRegistry.Unauthorized.selector);prediction(); }
    function testOnlyOwnerSetOracle() public { vm.expectRevert();vm.prank(A);r.setOracle(A,true); }
    function testFactorySetOnce() public { rejects(PredictionRegistry.InvalidInput.selector);r.setFactory(address(f)); }
    function testFactoryRejectEOA() public { PredictionRegistry fresh=new PredictionRegistry(address(this));rejects(PredictionRegistry.InvalidInput.selector);fresh.setFactory(A); }
    function testFactoryOwnError() public { rejects(CampaignFactory.InvalidInput.selector);new CampaignFactory(A); }
    function testFactoryCountAndRegistration() public view { assert(f.campaignCount()==1);assert(r.campaigns(address(c)));assert(c.author()==AUTHOR);assert(c.factory()==address(f));assert(c.milestoneCount()==2); }
    function testFactoryPaused() public { r.setPaused(true);rejects(CampaignFactory.SystemPaused.selector);create(1 ether,4000,6000); }
    function testRegisterCaller() public { rejects(PredictionRegistry.Unauthorized.selector);r.registerCampaign(address(c)); }
    function testRegisterDuplicate() public { rejects(PredictionRegistry.InvalidInput.selector);vm.prank(address(f));r.registerCampaign(address(c)); }
    function testRegisterEOA() public { rejects(PredictionRegistry.InvalidInput.selector);vm.prank(address(f));r.registerCampaign(A); }
    function testRegisterPaused() public { r.setPaused(true);rejects(PredictionRegistry.SystemPaused.selector);vm.prank(address(f));r.registerCampaign(A); }
    function testModelZero() public { rejects(PredictionRegistry.InvalidInput.selector);r.registerModel(bytes32(0),"x"); }
    function testModelEmptyURI() public { rejects(PredictionRegistry.InvalidInput.selector);r.registerModel(keccak256("x"),""); }
    function testModelURITooLong() public {
        rejects(PredictionRegistry.InvalidInput.selector);r.registerModel(keccak256("long"),string(new bytes(257)));
    }
    function testFactoryCreationEventAuthorAndHash() public {
        vm.expectEmit(false,true,false,true,address(f));emit CampaignCreated(address(0),AUTHOR,META);
        Campaign created=create(1 ether,4000,6000);assert(r.campaigns(address(created)));assert(f.campaignCount()==2);
    }
    function testModelDuplicate() public { rejects(PredictionRegistry.InvalidInput.selector);r.registerModel(MODEL,"x"); }
    function testModelUnknownToggle() public { rejects(PredictionRegistry.InvalidInput.selector);r.setModelEnabled(META,false); }
    function testModelDisabledPrediction() public { r.setModelEnabled(MODEL,false);rejects(PredictionRegistry.InvalidInput.selector);prediction(); }
    function testDisableInvalidatesExisting() public { prediction();r.setModelEnabled(MODEL,false);assert(!r.hasValidPrediction(address(c)));r.setModelEnabled(MODEL,true);assert(r.hasValidPrediction(address(c))); }
    function testPredictionAbsent() public view { assert(!r.hasValidPrediction(address(c))); }
    function testPredictionExpiresAtBoundary() public { prediction();vm.warp(block.timestamp+1000);assert(!r.hasValidPrediction(address(c))); }
    function testPredictionNotDraft() public { start();rejects(PredictionRegistry.NotDraft.selector);prediction(); }
    function testPredictionInputMismatch() public { invalid(7200,AUDIT,MODEL,uint64(block.timestamp+100),AUDIT); }
    function testPredictionScoreRange() public { invalid(10001,META,MODEL,uint64(block.timestamp+100),AUDIT); }
    function testPredictionUnknownModel() public { invalid(7200,META,META,uint64(block.timestamp+100),AUDIT); }
    function testPredictionEmptyAudit() public { invalid(7200,META,MODEL,uint64(block.timestamp+100),bytes32(0)); }
    function testPredictionAlreadyExpired() public { invalid(7200,META,MODEL,uint64(block.timestamp),AUDIT); }
    function testPredictionTooLong() public { invalid(7200,META,MODEL,uint64(block.timestamp+7 days+1),AUDIT); }
    function testPredictionUnregistered() public { rejects(PredictionRegistry.InvalidInput.selector);vm.prank(ORACLE);r.publishPrediction(A,7000,META,MODEL,AUDIT,uint64(block.timestamp+100)); }
    function testOwnershipTwoStep() public { r.transferOwnership(A);assert(r.owner()==address(this)&&r.pendingOwner()==A);vm.prank(A);r.acceptOwnership();assert(r.owner()==A);vm.expectRevert();r.setPaused(true);vm.prank(A);r.setPaused(true); }
    function testRenunciationDisabled() public { rejects(PredictionRegistry.RenunciationDisabled.selector);r.renounceOwnership(); }
    function invalid(uint16 score,bytes32 input,bytes32 model,uint64 expiry,bytes32 audit) internal {
        rejects(PredictionRegistry.InvalidInput.selector);vm.prank(ORACLE);r.publishPrediction(address(c),score,input,model,audit,expiry);
    }
}
contract ConstructorTest is Support {
    function construct(address author,address registry,bytes32 meta,uint256 goal,uint64 deadline,uint64 voting,uint64 window,uint16[] memory bps) internal {
        rejects(Campaign.InvalidInput.selector);new Campaign(author,registry,meta,goal,deadline,voting,window,bps);
    }
    function shares(uint16 a,uint16 b) internal pure returns(uint16[] memory x) { x=new uint16[](2);x[0]=a;x[1]=b; }
    function testInvalidAuthor() public { construct(address(0),address(r),META,100,uint64(block.timestamp+10),60,60,shares(4000,6000)); }
    function testInvalidRegistry() public { construct(AUTHOR,A,META,100,uint64(block.timestamp+10),60,60,shares(4000,6000)); }
    function testInvalidMetadata() public { construct(AUTHOR,address(r),bytes32(0),100,uint64(block.timestamp+10),60,60,shares(4000,6000)); }
    function testInvalidGoalZero() public { construct(AUTHOR,address(r),META,0,uint64(block.timestamp+10),60,60,shares(4000,6000)); }
    function testInvalidGoalLarge() public { construct(AUTHOR,address(r),META,uint256(type(uint128).max)+1,uint64(block.timestamp+10),60,60,shares(4000,6000)); }
    function testInvalidDeadlinePast() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp),60,60,shares(4000,6000)); }
    function testInvalidDeadlineLong() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp+90 days+1),60,60,shares(4000,6000)); }
    function testInvalidVotingShort() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp+10),59,60,shares(4000,6000)); }
    function testInvalidVotingLong() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp+10),uint64(30 days+1),60,shares(4000,6000)); }
    function testInvalidWindowShort() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp+10),60,59,shares(4000,6000)); }
    function testInvalidWindowLong() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp+10),60,uint64(90 days+1),shares(4000,6000)); }
    function testInvalidNoMilestones() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp+10),60,60,new uint16[](0)); }
    function testInvalidManyMilestones() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp+10),60,60,new uint16[](21)); }
    function testInvalidSum() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp+10),60,60,shares(4000,5000)); }
    function testInvalidZeroShare() public { construct(AUTHOR,address(r),META,100,uint64(block.timestamp+10),60,60,shares(0,10000)); }
    function testInvalidDustShare() public { construct(AUTHOR,address(r),META,1,uint64(block.timestamp+10),60,60,shares(4000,6000)); }
}
