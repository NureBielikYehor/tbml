// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "./Campaign.sol";
import {PredictionRegistry} from "./PredictionRegistry.sol";

contract CampaignFactory {
    PredictionRegistry public immutable registry;
    address[] public campaigns;
    event CampaignCreated(address indexed campaign, address indexed author, bytes32 metadataHash);

    constructor(address registry_) { registry = PredictionRegistry(registry_); }

    function campaignCount() external view returns (uint256) { return campaigns.length; }

    function createCampaign(bytes32 metadataHash, uint256 goal, uint64 deadline,
                            uint64 votingDuration, uint64 submissionWindow,
                            uint16[] calldata milestoneBps) external returns (address) {
        Campaign campaign = new Campaign(msg.sender, address(registry), metadataHash, goal,
                                         deadline, votingDuration, submissionWindow, milestoneBps);
        address result = address(campaign);
        campaigns.push(result);
        registry.registerCampaign(result);
        emit CampaignCreated(result, msg.sender, metadataHash);
        return result;
    }
}
