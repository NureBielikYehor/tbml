// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "./Campaign.sol";
import {PredictionRegistry} from "./PredictionRegistry.sol";

contract CampaignFactory {
    error InvalidInput();
    error SystemPaused();
    /// @notice Registry used for predictions and the global emergency pause.
    PredictionRegistry public immutable registry;
    /// @notice Factory campaign index or registry allowlist, depending on this contract.
    address[] public campaigns;
    event CampaignCreated(address indexed campaign, address indexed author, bytes32 metadataHash);

    /// @notice Initialize validated contract configuration and immutable dependencies.
    constructor(address registry_) {
        if (registry_.code.length == 0) revert InvalidInput();
        registry = PredictionRegistry(registry_);
    }

    /// @notice Return the number of factory-created campaigns.
    function campaignCount() external view returns (uint256) { return campaigns.length; }

    /// @notice Create and register a campaign owned by the caller; reject invalid campaign parameters.
    function createCampaign(bytes32 metadataHash, uint256 goal, uint64 deadline,
                            uint64 votingDuration, uint64 submissionWindow,
                            uint16[] calldata milestoneBps) external returns (address) {
        if (registry.paused()) revert SystemPaused();
        Campaign campaign = new Campaign(msg.sender, address(registry), metadataHash, goal,
                                         deadline, votingDuration, submissionWindow, milestoneBps);
        address result = address(campaign);
        campaigns.push(result);
        emit CampaignCreated(result, msg.sender, metadataHash);
        registry.registerCampaign(result);
        return result;
    }
}
