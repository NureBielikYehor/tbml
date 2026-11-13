// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Campaign} from "../../contracts/Campaign.sol";
import {CampaignFactory} from "../../contracts/CampaignFactory.sol";
import {PredictionRegistry} from "../../contracts/PredictionRegistry.sol";
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address,uint256) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function expectEmit(bool,bool,bool,bool,address) external;
}
contract Support {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PredictionRegistry internal r;
    CampaignFactory internal f;
    Campaign internal c;
    address internal constant AUTHOR = address(101);
    address internal constant A = address(102);
    address internal constant B = address(103);
    address internal constant ORACLE = address(104);
    address internal constant OTHER = address(105);
    bytes32 internal constant META = keccak256("metadata");
    bytes32 internal constant MODEL = keccak256("model");
    bytes32 internal constant AUDIT = keccak256("audit");
    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.deal(A,100 ether); vm.deal(B,100 ether); vm.deal(AUTHOR,100 ether);
        r = new PredictionRegistry(address(this));
        f = new CampaignFactory(address(r));
        r.setFactory(address(f)); r.setOracle(ORACLE,true); r.registerModel(MODEL,"ipfs://model");
        c = create(10 ether, 4000, 6000);
    }
    function create(uint256 goal,uint16 first,uint16 second) internal returns(Campaign) {
        uint16[] memory bps = new uint16[](2); bps[0]=first; bps[1]=second;
        vm.prank(AUTHOR);
        return Campaign(f.createCampaign(META,goal,uint64(block.timestamp+3600),60,120,bps));
    }
    function prediction() internal {
        vm.prank(ORACLE); r.publishPrediction(address(c),7200,META,MODEL,AUDIT,uint64(block.timestamp+1000));
    }
    function start() internal { prediction(); vm.prank(AUTHOR); c.startFunding(); }
    function funded() internal { start(); vm.prank(A); c.contribute{value:6 ether}(); vm.prank(B); c.contribute{value:4 ether}(); }
    function report() internal { vm.prank(AUTHOR); c.submitReport(keccak256("report")); }
    function approve() internal {
        report(); vm.prank(A); c.vote(true); vm.prank(B); c.vote(true); vm.warp(block.timestamp+60); c.finalizeMilestone();
    }
    function rejects(bytes4 reason) internal { vm.expectRevert(reason); }
}
