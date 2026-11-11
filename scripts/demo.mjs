import assert from "node:assert/strict";
import fs from "node:fs";
import { Contract, parseEther, formatEther } from "ethers";
import { provider } from "../server/chain.mjs";

const base = process.env.APP_URL || "http://127.0.0.1:3000";
async function api(path, body) {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "API request failed");
  return value;
}
const rpc = provider();
try {
  const config = await api("/api/config");
  const author = await rpc.getSigner(1), a = await rpc.getSigner(2), b = await rpc.getSigner(3);
  const f = new Contract(config.factory, config.abi.CampaignFactory, author);
  const saved = await api("/api/metadata", {
    title: "Артбук Незалежні історії", description: "An illustrated art book celebrating independent artists. We will create a prototype, print the first edition and deliver a carefully designed collection to our supporters.",
    goalEth: "10", budgetGoal: 10000, category: "Art Books", main_category: "Publishing", currency: "USD", country: "US",
    durationDays: 30, votingDuration: 60, submissionWindow: 120,
    milestoneBps: [4000, 6000], milestoneTitles: ["Прототип та макет", "Друк та доставка"],
  });
  const m = saved.metadata;
  const receipts = [];
  async function record(label, promise) {
    const started = performance.now();
    const receipt = await (await promise).wait();
    receipts.push({ action: label, transactionHash: receipt.hash, gasUsed: receipt.gasUsed.toString(),
      local_submit_and_confirmation_ms: performance.now() - started });
    console.log(label, receipt.hash);
  }
  await record("create", f.createCampaign(saved.hash, m.goalWei, m.fundingDeadline, m.votingDuration, m.submissionWindow, m.milestoneBps));
  const address = await f.campaigns((await f.campaignCount()) - 1n);
  const campaign = new Contract(address, config.abi.Campaign, author);
  const score = await api(`/api/campaigns/${address}/score`, {});
  receipts.push({ action: "oracle_prediction", transactionHash: score.transactionHash });
  await record("start", campaign.startFunding());
  await record("contribute_A_6", campaign.connect(a).contribute({ value: parseEther("6") }));
  await record("contribute_B_4", campaign.connect(b).contribute({ value: parseEther("4") }));
  assert.equal(await campaign.state(), 2n);
  const first = await api("/api/reports", { body: "Створено прототип артбуку та готовий макет першого видання." });
  await record("report_1", campaign.submitReport(first.hash));
  await record("vote_A_yes", campaign.connect(a).vote(true));
  await record("vote_B_yes", campaign.connect(b).vote(true));
  await api("/api/dev/advance", { seconds: 61 });
  await record("approve_1", campaign.finalizeMilestone());
  await record("withdraw_first_tranche_4", campaign.withdrawPayout(await author.getAddress()));
  const second = await api("/api/reports", { body: "Друк і доставку не завершено. Вкладники перевіряють невиконані умови другого етапу." });
  await record("report_2", campaign.submitReport(second.hash));
  await record("vote_A_no", campaign.connect(a).vote(false));
  await record("vote_B_no", campaign.connect(b).vote(false));
  await api("/api/dev/advance", { seconds: 61 });
  await record("reject_2", campaign.finalizeMilestone());
  const refundA = await campaign.refundable(await a.getAddress());
  const refundB = await campaign.refundable(await b.getAddress());
  assert.equal(refundA, parseEther("3.6")); assert.equal(refundB, parseEther("2.4"));
  await record("refund_A_3.6", campaign.connect(a).claimRefund(await a.getAddress()));
  await record("refund_B_2.4", campaign.connect(b).claimRefund(await b.getAddress()));
  assert.equal(await rpc.getBalance(address), 0n);
  const timings = receipts.filter(r => r.local_submit_and_confirmation_ms !== undefined)
    .map(r => r.local_submit_and_confirmation_ms).sort((x, y) => x - y);
  const result = {
    executedAt: new Date().toISOString(), chainId: config.chainId, campaign: address,
    modelHash: score.prediction.modelHash, predictionScoreBps: score.scoreBps,
    initialCollectedEth: "10.0", authorReleasedEth: formatEther(await campaign.totalReleased()),
    refundAEth: formatEther(refundA), refundBEth: formatEther(refundB), remainingContractBalanceWei: "0",
    local_transaction_p95_ms: timings[Math.ceil(timings.length * .95) - 1],
    receipts, note: "A real execution on ephemeral local chain 31337; gas is measured, no live fiat gas price is assumed.",
  };
  fs.mkdirSync("reports/blockchain", { recursive: true });
  fs.writeFileSync("reports/blockchain/demo.json", JSON.stringify(result, null, 2));
  console.log("PASS: 10 ETH = 4 ETH paid to author + 3.6/2.4 ETH refunded. Contract balance = 0.");
} finally { rpc.destroy(); }
