import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import hre from "hardhat";
import solc from "solc";
import { BrowserProvider, Contract, ContractFactory, id, parseEther, ZeroAddress } from "ethers";

let connection, provider, signers;
const artifacts = Object.fromEntries(["PredictionRegistry", "CampaignFactory", "Campaign"].map(name =>
  [name, JSON.parse(fs.readFileSync(`artifacts/${name}.json`))]));
const modelHash = id("real-model-fixture");
const metadataHash = id("immutable-campaign-input");

before(async () => {
  const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity",
    sources: { "Probe.sol": { content: fs.readFileSync("tests/contracts/RefundProbe.sol", "utf8") } },
    settings: { evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const probe = output.contracts["Probe.sol"].RefundProbe;
  artifacts.RefundProbe = { abi: probe.abi, bytecode: "0x" + probe.evm.bytecode.object };
  connection = await hre.network.create("local");
  provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  signers = await Promise.all(Array.from({ length: 8 }, (_, i) => provider.getSigner(i)));
});
after(async () => { await connection?.close(); });

async function deploy(name, args, signer = signers[0]) {
  const a = artifacts[name];
  const value = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await value.waitForDeployment();
  return value;
}
async function time() { return Number((await provider.getBlock("latest")).timestamp); }
async function advance(seconds) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}
async function fixture({ goal = parseEther("10"), bps = [4000, 6000] } = {}) {
  const registry = await deploy("PredictionRegistry", [await signers[0].getAddress()]);
  const factory = await deploy("CampaignFactory", [registry.target]);
  await (await registry.setFactory(factory.target)).wait();
  await (await registry.setOracle(await signers[4].getAddress(), true)).wait();
  await (await registry.registerModel(modelHash, "sha256:fixture-manifest")).wait();
  await (await factory.connect(signers[1]).createCampaign(metadataHash, goal, await time() + 3600,
                                                        60, 120, bps)).wait();
  const campaign = new Contract(await factory.campaigns(0), artifacts.Campaign.abi, signers[1]);
  return { registry, factory, campaign };
}
async function predict(f) {
  await (await f.registry.connect(signers[4]).publishPrediction(f.campaign.target, 7200,
    metadataHash, modelHash, id("audit"), await time() + 1000)).wait();
}
async function fund(f, first = parseEther("6"), second = parseEther("4")) {
  await predict(f);
  await (await f.campaign.startFunding()).wait();
  await (await f.campaign.connect(signers[2]).contribute({ value: first })).wait();
  await (await f.campaign.connect(signers[3]).contribute({ value: second })).wait();
}
async function reportAndApprove(f) {
  await (await f.campaign.submitReport(id("first-milestone-report"))).wait();
  await (await f.campaign.connect(signers[2]).vote(true)).wait();
  await advance(61);
  await (await f.campaign.connect(signers[6]).finalizeMilestone()).wait();
}

test("mandatory scenario: prediction, 10 ETH, first 4 ETH, reject second, refund 3.6/2.4 ETH", async () => {
  const f = await fixture();
  await fund(f);
  assert.equal(await f.campaign.state(), 2n);
  await reportAndApprove(f);
  const payoutRecipient = await signers[7].getAddress();
  const before = await provider.getBalance(payoutRecipient);
  await (await f.campaign.withdrawPayout(payoutRecipient)).wait();
  assert.equal(await provider.getBalance(payoutRecipient) - before, parseEther("4"));
  await (await f.campaign.submitReport(id("second-milestone-report"))).wait();
  await (await f.campaign.connect(signers[2]).vote(false)).wait();
  await advance(61);
  await (await f.campaign.finalizeMilestone()).wait();
  assert.equal(await f.campaign.refundPool(), parseEther("6"));
  assert.equal(await f.campaign.refundable(await signers[2].getAddress()), parseEther("3.6"));
  assert.equal(await f.campaign.refundable(await signers[3].getAddress()), parseEther("2.4"));
  for (const index of [2, 3]) {
    await (await f.campaign.connect(signers[index]).claimRefund(await signers[index].getAddress())).wait();
  }
  assert.equal(await provider.getBalance(f.campaign.target), 0n);
  assert.equal(await f.campaign.totalReleased(), parseEther("4"));
  assert.equal(await f.campaign.totalRefunded(), parseEther("6"));
  await assert.rejects(() => f.campaign.connect(signers[2]).claimRefund(payoutRecipient));
});

test("no funding without a current enabled model prediction; expired prediction is rejected", async () => {
  const f = await fixture();
  await assert.rejects(() => f.campaign.startFunding());
  await assert.rejects(() => f.campaign.connect(signers[2]).contribute({ value: 1n }));
  await predict(f);
  await advance(1001);
  await assert.rejects(() => f.campaign.startFunding());
});

test("registry enforces admin, oracle, input hash, model hash, score, and draft-only updates", async () => {
  const f = await fixture();
  await assert.rejects(() => f.registry.connect(signers[2]).setOracle(awaitAddress(signers[2]), true));
  const args = [f.campaign.target, 7000, metadataHash, modelHash, id("audit"), await time() + 1000];
  await assert.rejects(() => f.registry.connect(signers[2]).publishPrediction(...args));
  for (const [index, value] of [[1, 10001], [2, id("wrong input")], [3, id("unknown model")]]) {
    const invalid = [...args]; invalid[index] = value;
    await assert.rejects(() => f.registry.connect(signers[4]).publishPrediction(...invalid));
  }
  await predict(f);
  await (await f.campaign.startFunding()).wait();
  await assert.rejects(() => f.registry.connect(signers[4]).publishPrediction(...args));
});

function awaitAddress(signer) { return signer.getAddress(); }

test("overfunding, self-funding, zero contributions and unauthorized reports/votes are rejected", async () => {
  const f = await fixture(); await predict(f); await (await f.campaign.startFunding()).wait();
  await assert.rejects(() => f.campaign.contribute({ value: 1n }));
  await assert.rejects(() => f.campaign.connect(signers[2]).contribute({ value: 0n }));
  await assert.rejects(() => f.campaign.connect(signers[2]).contribute({ value: parseEther("11") }));
  await (await f.campaign.connect(signers[2]).contribute({ value: parseEther("10") })).wait();
  await assert.rejects(() => f.campaign.connect(signers[2]).submitReport(id("report")));
  await (await f.campaign.submitReport(id("report"))).wait();
  await assert.rejects(() => f.campaign.connect(signers[6]).vote(true));
  await (await f.campaign.connect(signers[2]).vote(true)).wait();
  await assert.rejects(() => f.campaign.connect(signers[2]).vote(false));
  await assert.rejects(() => f.campaign.finalizeMilestone());
});

test("failed funding refunds all contributions and anyone can finalize after deadline", async () => {
  const f = await fixture(); await predict(f); await (await f.campaign.startFunding()).wait();
  await (await f.campaign.connect(signers[2]).contribute({ value: parseEther("2") })).wait();
  await assert.rejects(() => f.campaign.finalizeFunding());
  await advance(3601);
  await (await f.campaign.connect(signers[6]).finalizeFunding()).wait();
  assert.equal(await f.campaign.refundPool(), parseEther("2"));
  await (await f.campaign.connect(signers[2]).claimRefund(await signers[7].getAddress())).wait();
  assert.equal(await provider.getBalance(f.campaign.target), 0n);
});

test("inactivity, no quorum and tied votes fail safely into refunds", async () => {
  for (const scenario of ["inactivity", "no quorum", "tie"]) {
    const f = await fixture();
    await fund(f, parseEther("5"), parseEther("5"));
    if (scenario === "inactivity") {
      await advance(121); await (await f.campaign.expireSubmission()).wait();
    } else {
      await (await f.campaign.submitReport(id("report"))).wait();
      if (scenario === "tie") {
        await (await f.campaign.connect(signers[2]).vote(true)).wait();
        await (await f.campaign.connect(signers[3]).vote(false)).wait();
      }
      await advance(61); await (await f.campaign.finalizeMilestone()).wait();
    }
    assert.equal(await f.campaign.state(), 5n, scenario);
    assert.equal(await f.campaign.refundPool(), parseEther("10"), scenario);
  }
});

test("all milestones complete; approved but unclaimed author credit survives later rejection", async () => {
  const completed = await fixture(); await fund(completed);
  await reportAndApprove(completed); await reportAndApprove(completed);
  assert.equal(await completed.campaign.state(), 4n);
  assert.equal(await completed.campaign.authorCredit(), parseEther("10"));
  await (await completed.campaign.withdrawPayout(await signers[7].getAddress())).wait();
  await assert.rejects(() => completed.campaign.withdrawPayout(signers[7].address));
  const rejected = await fixture(); await fund(rejected); await reportAndApprove(rejected);
  await advance(121); await (await rejected.campaign.expireSubmission()).wait();
  for (const i of [2, 3]) await (await rejected.campaign.connect(signers[i]).claimRefund(await signers[i].getAddress())).wait();
  assert.equal(await provider.getBalance(rejected.campaign.target), parseEther("4"));
  await (await rejected.campaign.withdrawPayout(await signers[7].getAddress())).wait();
  assert.equal(await provider.getBalance(rejected.campaign.target), 0n);
});

test("rounding distributes the entire remainder without overstating liabilities", async () => {
  const f = await fixture({ goal: 11n, bps: [4000, 6000] });
  await fund(f, 7n, 4n); await reportAndApprove(f);
  assert.equal(await f.campaign.authorCredit(), 4n);
  await advance(121); await (await f.campaign.expireSubmission()).wait();
  await (await f.campaign.connect(signers[2]).claimRefund(await signers[2].getAddress())).wait();
  assert.equal(await f.campaign.refundable(await signers[3].getAddress()), 3n);
  await (await f.campaign.connect(signers[3]).claimRefund(await signers[3].getAddress())).wait();
  assert.equal(await f.campaign.totalRefunded(), 7n);
  await (await f.campaign.withdrawPayout(await signers[7].getAddress())).wait();
  assert.equal(await provider.getBalance(f.campaign.target), 0n);
});

test("invalid schedules and zero recipient are rejected; disabled model blocks launch", async () => {
  await assert.rejects(() => fixture({ bps: [3000, 6000] }));
  const f = await fixture(); await predict(f);
  await (await f.registry.setModelEnabled(modelHash, false)).wait();
  await assert.rejects(() => f.campaign.startFunding());
  await (await f.registry.setModelEnabled(modelHash, true)).wait();
  await (await f.campaign.startFunding()).wait();
  await (await f.campaign.connect(signers[2]).contribute({ value: parseEther("10") })).wait();
  await reportAndApprove(f);
  await assert.rejects(() => f.campaign.withdrawPayout(ZeroAddress));
});

test("a reverting refund recipient retains its claim; reentrancy cannot obtain a second refund", async () => {
  const f = await fixture(); await predict(f); await (await f.campaign.startFunding()).wait();
  const attacker = await deploy("RefundProbe", []);
  await (await attacker.fund(f.campaign.target, { value: parseEther("4") })).wait();
  await (await f.campaign.connect(signers[2]).contribute({ value: parseEther("6") })).wait();
  await advance(121); await (await f.campaign.expireSubmission()).wait();
  await assert.rejects(() => attacker.claim(false, true));
  assert.equal(await f.campaign.refundClaimed(attacker.target), false);
  assert.equal(await f.campaign.refundable(attacker.target), parseEther("4"));
  await (await attacker.claim(true, false)).wait();
  assert.equal(await attacker.nestedSucceeded(), false);
  assert.equal(await provider.getBalance(attacker.target), parseEther("4"));
  assert.equal(await f.campaign.totalRefunded(), parseEther("4"));
  await (await f.campaign.connect(signers[2]).claimRefund(signers[2].address)).wait();
  assert.equal(await provider.getBalance(f.campaign.target), 0n);
});
