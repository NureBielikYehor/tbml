// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IRefundCampaign {
    function contribute() external payable;
    function claimRefund(address payable recipient) external;
}
contract RefundProbe {
    IRefundCampaign public campaign;
    bool public attack;
    bool public refuse;
    bool public nestedSucceeded;
    function fund(address target) external payable {
        campaign = IRefundCampaign(target);
        campaign.contribute{value: msg.value}();
    }
    function claim(bool attack_, bool refuse_) external {
        attack = attack_; refuse = refuse_;
        campaign.claimRefund(payable(address(this)));
    }
    receive() external payable {
        require(!refuse, "recipient refuses ETH");
        if (attack) {
            attack = false;
            (nestedSucceeded,) = address(campaign).call(abi.encodeCall(IRefundCampaign.claimRefund, (payable(address(this)))));
        }
    }
}
