import express from "express";
import fs from "node:fs";
import { isAddress } from "ethers";
import { artifact, contract, deployment, jsonSafe, provider, requireLocalChain } from "./chain.mjs";
import { campaignMetadata, readContent, saveContent } from "./content.mjs";
import { PythonWorker } from "./worker.mjs";

const app = express();
const port = Number(process.env.PORT || 3000);
const rpc = provider();
await requireLocalChain(rpc);
const config = deployment();
if (await rpc.getCode(config.factory) === "0x") throw new Error("Local chain has reset; run npm run deploy");
const factory = contract("CampaignFactory", config.factory, rpc);
const registry = contract("PredictionRegistry", config.registry, rpc);
const worker = new PythonWorker();
let queue = Promise.resolve();
function serial(task) { const result = queue.then(task); queue = result.catch(() => {}); return result; }
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'");
  if (req.method !== "GET" && req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin)) {
    return res.status(403).json({ error: "Cross-origin writes are not allowed" });
  }
  next();
});
app.use(express.json({ limit: "256kb" }));
app.post("/rpc", async (req, res) => {
  const isBatch = Array.isArray(req.body);
  const requests = isBatch ? req.body : [req.body];
  if (!req.is("application/json") || requests.length === 0 || requests.length > 50 ||
      !requests.every(item => item && typeof item.method === "string" && Array.isArray(item.params || []))) {
    return res.status(400).json({ error: "Invalid JSON-RPC request" });
  }
  const replies = await Promise.all(requests.map(async item => {
    try {
      return { jsonrpc: "2.0", id: item.id, result: await rpc.send(item.method, item.params || []) };
    } catch (error) {
      const detail = error.info?.error || error.error;
      return { jsonrpc: "2.0", id: item.id, error: { code: detail?.code ?? -32000,
        message: detail?.message || error.shortMessage || error.message, data: detail?.data || error.data } };
    }
  }));
  res.json(isBatch ? replies : replies[0]);
});
app.get("/api/config", async (req, res) => {
  const accounts = await rpc.send("eth_accounts", []);
  res.json({ ...config, accounts, blockTime: (await rpc.getBlock("latest")).timestamp,
    abi: Object.fromEntries(["Campaign", "CampaignFactory", "PredictionRegistry"].map(name => [name, artifact(name).abi])) });
});
app.get("/api/model", (req, res) => res.status(worker.metadata ? 200 : 503).json(worker.metadata || { error: worker.error || "ML model is loading" }));
app.get("/api/catalog", (req, res) => {
  const path = "reports/data/catalog.json";
  res.json(fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : { categories: [{ category: "Product Design", main_category: "Design" }], currencies: ["USD"], countries: ["US"] });
});
app.get("/api/content/:hash", (req, res) => res.json(readContent(req.params.hash)));
app.post("/api/metadata", async (req, res) => {
  const value = campaignMetadata(req.body, (await rpc.getBlock("latest")).timestamp);
  res.status(201).json({ hash: saveContent(value), metadata: value });
});
app.post("/api/reports", (req, res) => {
  if (typeof req.body.body !== "string" || req.body.body.trim().length < 10 || req.body.body.length > 100000) throw new Error("Report must contain 10–100000 characters");
  const value = { type: "milestone-report", body: req.body.body.trim(), createdAt: new Date().toISOString() };
  res.status(201).json({ hash: saveContent(value), report: value });
});
async function campaignAt(address) {
  if (!isAddress(address) || !await registry.campaigns(address)) throw new Error("Unknown campaign");
  return contract("Campaign", address, rpc);
}
async function summary(address) {
  const campaign = await campaignAt(address);
  const [state, metadataHash, goal, total, released, author, credit, index, count, deadline, submissionDeadline, pool, prediction] = await Promise.all([
    campaign.state(), campaign.metadataHash(), campaign.goal(), campaign.totalContributed(), campaign.totalReleased(),
    campaign.author(), campaign.authorCredit(), campaign.currentMilestone(), campaign.milestoneCount(), campaign.fundingDeadline(),
    campaign.submissionDeadline(), campaign.refundPool(), registry.predictions(address),
  ]);
  let metadata; try { metadata = readContent(metadataHash); } catch { metadata = { title: address, description: "Metadata unavailable" }; }
  const milestones = await Promise.all(Array.from({ length: Number(count) }, async (_, i) => {
    const m = await campaign.milestones(i);
    return { amount: m.amount, reportHash: m.reportHash, voteDeadline: m.voteDeadline,
      yesWeight: m.yesWeight, noWeight: m.noWeight, status: Number(m.status) };
  }));
  return jsonSafe({ address, state: Number(state), metadataHash, metadata, goal, total, released, author, authorCredit: credit,
    currentMilestone: Number(index), fundingDeadline: deadline, submissionDeadline, refundPool: pool, milestones,
    prediction: prediction.publishedAt === 0n ? null : { scoreBps: Number(prediction.scoreBps), modelHash: prediction.modelHash,
      auditHash: prediction.auditHash, publishedAt: prediction.publishedAt, expiresAt: prediction.expiresAt } });
}
app.get("/api/campaigns", async (req, res) => {
  const count = Number(await factory.campaignCount());
  const offset = Math.max(0, Math.min(count, Number(req.query.offset) || 0));
  const addresses = await Promise.all(Array.from({ length: Math.min(50, count - offset) }, (_, i) => factory.campaigns(count - 1 - offset - i)));
  res.json({ count, campaigns: await Promise.all(addresses.map(summary)), blockTime: (await rpc.getBlock("latest")).timestamp });
});
app.get("/api/campaigns/:address", async (req, res) => res.json(await summary(req.params.address)));
app.post("/api/campaigns/:address/score", async (req, res) => {
  const result = await serial(async () => {
    const campaign = await campaignAt(req.params.address);
    if (await campaign.state() !== 0n) throw new Error("Only draft campaigns can receive a new prediction");
    const inputHash = await campaign.metadataHash();
    const metadata = readContent(inputHash);
    if (metadata.type !== "campaign" || BigInt(metadata.goalWei) !== await campaign.goal() ||
        BigInt(metadata.fundingDeadline) !== await campaign.fundingDeadline() ||
        BigInt(metadata.votingDuration) !== await campaign.votingDuration() ||
        BigInt(metadata.submissionWindow) !== await campaign.submissionWindow() ||
        metadata.milestoneBps.length !== Number(await campaign.milestoneCount())) throw new Error("Campaign metadata mismatch");
    let allocated = 0n;
    for (let index = 0; index < metadata.milestoneBps.length; index++) {
      const expected = index + 1 === metadata.milestoneBps.length ? BigInt(metadata.goalWei) - allocated :
        BigInt(metadata.goalWei) * BigInt(metadata.milestoneBps[index]) / 10000n;
      if ((await campaign.milestones(index)).amount !== expected) throw new Error("Milestone metadata mismatch");
      allocated += expected;
    }
    const prediction = await worker.predict({ goal: metadata.budgetGoal, duration_days: metadata.durationDays,
      launch_at: metadata.launchAt, category: metadata.category, main_category: metadata.main_category,
      country: metadata.country, currency: metadata.currency, description: metadata.description });
    if (!Number.isFinite(prediction.probability) || prediction.probability < 0 || prediction.probability > 1) throw new Error("Invalid model output");
    const admin = await rpc.getSigner(0);
    const model = await registry.models(prediction.modelHash);
    if (!model.manifestURI) {
      const manifestHash = saveContent({ type: "model-manifest", ...worker.metadata });
      await (await registry.connect(admin).registerModel(prediction.modelHash, `/api/content/${manifestHash}`)).wait();
    }
    const now = (await rpc.getBlock("latest")).timestamp;
    const audit = { type: "model-decision", version: 1, campaign: req.params.address.toLowerCase(), chainId: 31337,
      inputHash, ...prediction, computedAt: now };
    const auditHash = saveContent(audit);
    const scoreBps = Math.round(prediction.probability * 10000);
    const tx = await registry.connect(await rpc.getSigner(4)).publishPrediction(campaign.target, scoreBps,
      inputHash, prediction.modelHash, auditHash, now + 86400);
    const receipt = await tx.wait();
    return { prediction, auditHash, transactionHash: receipt.hash, scoreBps };
  });
  res.json(result);
});
app.post("/api/dev/advance", async (req, res) => {
  const seconds = Number(req.body.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 90 * 86400) throw new Error("Invalid time step");
  await rpc.send("evm_increaseTime", [seconds]); await rpc.send("evm_mine", []);
  res.json({ blockTime: (await rpc.getBlock("latest")).timestamp });
});
app.get("/vendor/ethers.js", (req, res) => res.sendFile("ethers.min.js", { root: "node_modules/ethers/dist" }));
app.use(express.static("web"));
app.use((error, req, res, next) => {
  console.error(error.shortMessage || error.message);
  res.status(error.status || 400).json({ error: error.shortMessage || error.message || "Request failed" });
});
const server = app.listen(port, "127.0.0.1", () => console.log(`tbml: http://127.0.0.1:${port}`));
function close() { worker.close(); rpc.destroy(); server.close(() => process.exit(0)); }
process.on("SIGINT", close); process.on("SIGTERM", close);
