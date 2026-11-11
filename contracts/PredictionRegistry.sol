// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IPredictionCampaign {
    function state() external view returns (uint8);
    function metadataHash() external view returns (bytes32);
}

/// @notice Audits model versions and oracle decisions; it cannot release campaign funds.
contract PredictionRegistry is Ownable2Step {
    struct Model { bool enabled; string manifestURI; }
    struct Prediction {
        uint16 scoreBps;
        bytes32 inputHash;
        bytes32 modelHash;
        bytes32 auditHash;
        uint64 publishedAt;
        uint64 expiresAt;
    }

    address public factory;
    mapping(address => bool) public oracles;
    mapping(address => bool) public campaigns;
    mapping(bytes32 => Model) public models;
    mapping(address => Prediction) public predictions;

    error Unauthorized();
    error InvalidInput();
    error NotDraft();
    event FactorySet(address indexed factory);
    event OracleSet(address indexed oracle, bool enabled);
    event ModelRegistered(bytes32 indexed modelHash, string manifestURI);
    event ModelStatusChanged(bytes32 indexed modelHash, bool enabled);
    event CampaignRegistered(address indexed campaign);
    event PredictionPublished(address indexed campaign, uint16 scoreBps, bytes32 indexed modelHash,
                              bytes32 inputHash, bytes32 auditHash, uint64 expiresAt);

    constructor(address admin) Ownable(admin) {}

    function setFactory(address value) external onlyOwner {
        if (factory != address(0) || value.code.length == 0) revert InvalidInput();
        factory = value;
        emit FactorySet(value);
    }

    function setOracle(address oracle, bool enabled) external onlyOwner {
        if (oracle == address(0)) revert InvalidInput();
        oracles[oracle] = enabled;
        emit OracleSet(oracle, enabled);
    }

    function registerModel(bytes32 modelHash, string calldata manifestURI) external onlyOwner {
        if (modelHash == bytes32(0) || bytes(manifestURI).length == 0 ||
            bytes(models[modelHash].manifestURI).length != 0) revert InvalidInput();
        models[modelHash] = Model(true, manifestURI);
        emit ModelRegistered(modelHash, manifestURI);
    }

    function setModelEnabled(bytes32 modelHash, bool enabled) external onlyOwner {
        if (bytes(models[modelHash].manifestURI).length == 0) revert InvalidInput();
        models[modelHash].enabled = enabled;
        emit ModelStatusChanged(modelHash, enabled);
    }

    function registerCampaign(address campaign) external {
        if (msg.sender != factory) revert Unauthorized();
        if (campaign.code.length == 0 || campaigns[campaign]) revert InvalidInput();
        campaigns[campaign] = true;
        emit CampaignRegistered(campaign);
    }

    function publishPrediction(address campaign, uint16 scoreBps, bytes32 inputHash,
                               bytes32 modelHash, bytes32 auditHash, uint64 expiresAt) external {
        if (!oracles[msg.sender]) revert Unauthorized();
        if (!campaigns[campaign] || !models[modelHash].enabled || scoreBps > 10000 ||
            auditHash == bytes32(0) || expiresAt <= block.timestamp ||
            expiresAt > block.timestamp + 7 days) revert InvalidInput();
        if (IPredictionCampaign(campaign).state() != 0) revert NotDraft();
        if (inputHash != IPredictionCampaign(campaign).metadataHash()) revert InvalidInput();
        predictions[campaign] = Prediction(scoreBps, inputHash, modelHash, auditHash,
                                            uint64(block.timestamp), expiresAt);
        emit PredictionPublished(campaign, scoreBps, modelHash, inputHash, auditHash, expiresAt);
    }

    function hasValidPrediction(address campaign) external view returns (bool) {
        Prediction memory p = predictions[campaign];
        return p.publishedAt != 0 && p.expiresAt > block.timestamp && models[p.modelHash].enabled;
    }
}
