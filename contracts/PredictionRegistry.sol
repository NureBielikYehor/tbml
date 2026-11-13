// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IPredictionCampaign {
    /// @notice Return the campaign state or committed metadata hash.
    function state() external view returns (uint8);
    /// @notice Return the campaign state or committed metadata hash.
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

    /// @notice Emergency pause state; all campaign mutations are blocked while true.
    bool public paused;
    /// @notice The trusted factory address.
    address public factory;
    /// @notice Addresses authorized to publish predictions.
    mapping(address => bool) public oracles;
    /// @notice Factory campaign index or registry allowlist, depending on this contract.
    mapping(address => bool) public campaigns;
    /// @notice Model version hashes and enable/manifest metadata.
    mapping(bytes32 => Model) public models;
    /// @notice Latest committed prediction and audit metadata for each campaign.
    mapping(address => Prediction) public predictions;

    error Unauthorized();
    error SystemPaused();
    error RenunciationDisabled();
    error InvalidInput();
    error NotDraft();
    event PauseChanged(bool paused);
    event OracleRotated(address indexed previous, address indexed replacement);
    event FactorySet(address indexed factory);
    event OracleSet(address indexed oracle, bool enabled);
    event ModelRegistered(bytes32 indexed modelHash, string manifestURI);
    event ModelStatusChanged(bytes32 indexed modelHash, bool enabled);
    event CampaignRegistered(address indexed campaign);
    event PredictionPublished(address indexed campaign, uint16 scoreBps, bytes32 indexed modelHash,
                              bytes32 inputHash, bytes32 auditHash, uint64 expiresAt);

    /// @notice Initialize validated contract configuration and immutable dependencies.
    constructor(address admin) Ownable(admin) {}

    /// @notice Freeze or resume business operations. Deadlines continue while paused.
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseChanged(value);
    }

    /// @notice Atomically revoke the old oracle and authorize a distinct replacement.
    function rotateOracle(address previous, address replacement) external onlyOwner {
        if (!oracles[previous] || replacement == address(0) || replacement == previous) revert InvalidInput();
        oracles[previous] = false;
        oracles[replacement] = true;
        emit OracleSet(previous, false);
        emit OracleSet(replacement, true);
        emit OracleRotated(previous, replacement);
    }

    /// @notice Keep an administrator available for emergency recovery; transfer is two-step.
    function renounceOwnership() public view override onlyOwner { revert RenunciationDisabled(); }

    /// @notice Set the factory once; only the owner may call with a deployed contract.
    function setFactory(address value) external onlyOwner {
        if (factory != address(0) || value.code.length == 0) revert InvalidInput();
        factory = value;
        emit FactorySet(value);
    }

    /// @notice Enable or revoke an oracle address; only the owner may call.
    function setOracle(address oracle, bool enabled) external onlyOwner {
        if (oracle == address(0)) revert InvalidInput();
        oracles[oracle] = enabled;
        emit OracleSet(oracle, enabled);
    }

    /// @notice Register a unique model hash and the off-chain manifest URI; owner only.
    function registerModel(bytes32 modelHash, string calldata manifestURI) external onlyOwner {
        if (modelHash == bytes32(0) || bytes(manifestURI).length == 0 || bytes(manifestURI).length > 256 ||
            bytes(models[modelHash].manifestURI).length != 0) revert InvalidInput();
        models[modelHash] = Model(true, manifestURI);
        emit ModelRegistered(modelHash, manifestURI);
    }

    /// @notice Enable or disable an existing model; owner only.
    function setModelEnabled(bytes32 modelHash, bool enabled) external onlyOwner {
        if (bytes(models[modelHash].manifestURI).length == 0) revert InvalidInput();
        models[modelHash].enabled = enabled;
        emit ModelStatusChanged(modelHash, enabled);
    }

    /// @notice Register a deployed campaign; only the configured factory may call.
    function registerCampaign(address campaign) external {
        if (paused) revert SystemPaused();
        if (msg.sender != factory) revert Unauthorized();
        if (campaign.code.length == 0 || campaigns[campaign]) revert InvalidInput();
        campaigns[campaign] = true;
        emit CampaignRegistered(campaign);
    }

    /// @notice Store the score, model version and input/audit hashes for a registered draft; oracle only.
    function publishPrediction(address campaign, uint16 scoreBps, bytes32 inputHash,
                               bytes32 modelHash, bytes32 auditHash, uint64 expiresAt) external {
        if (paused) revert SystemPaused();
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

    /// @notice Return whether a prediction exists, is unexpired and references an enabled model.
    function hasValidPrediction(address campaign) external view returns (bool) {
        Prediction memory p = predictions[campaign];
        return p.publishedAt != 0 && p.expiresAt > block.timestamp && models[p.modelHash].enabled;
    }
}
