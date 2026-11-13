import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { contentDatabasePath } from "../server/content.mjs";
import { Contract } from "ethers";
import { provider } from "../server/chain.mjs";

const base = process.env.APP_URL || "http://127.0.0.1:3000";
async function post(path, body, headers = {}) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const input = { title: "API integrity verification", description: "A complete independent description for a local protocol integrity test campaign.",
  goalEth: "1", budgetGoal: 1000, durationDays: 30, category: "Art", main_category: "Art", country: "US", currency: "USD",
  milestoneBps: [4000, 6000], milestoneTitles: ["Prototype", "Delivery"] };

test("JSON-RPC proxy supports the batches used by browser ethers providers", async () => {
  const response = await post("/rpc", [
    { jsonrpc: "2.0", id: 101, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 102, method: "eth_accounts", params: [] },
  ]);
  assert.equal(response.status, 200);
  const values = await response.json();
  assert.equal(values.find(x => x.id === 101).result, "0x7a69");
  assert.ok(values.find(x => x.id === 102).result.length >= 5);
});

test("foreign origins, non-JSON RPC bodies, oversized inputs and invalid amounts are rejected", async () => {
  assert.equal((await post("/api/dev/advance", { seconds: 1 }, { Origin: "https://unrelated.example" })).status, 403);
  assert.equal((await fetch(base + "/rpc", { method: "POST", body: "untrusted form" })).status, 400);
  assert.equal((await post("/api/metadata", { ...input, goalEth: "-1" })).status, 400);
  assert.equal((await post("/api/metadata", { ...input, description: "x".repeat(300000) })).status, 413);
});

test("content corruption is detected instead of serving substituted metadata", async () => {
  const response = await post("/api/metadata", input); assert.equal(response.status, 201);
  const saved = await response.json();
  const db = new DatabaseSync(contentDatabasePath());
  const original = db.prepare("SELECT body FROM content WHERE hash = ?").get(saved.hash).body;
  try {
    db.prepare("UPDATE content SET body = ? WHERE hash = ?").run("{}", saved.hash);
    const result = await fetch(base + "/api/content/" + saved.hash);
    assert.equal(result.status, 400);
    assert.match((await result.json()).error, /integrity/);
  } finally { db.prepare("UPDATE content SET body = ? WHERE hash = ?").run(original, saved.hash); db.close(); }
  assert.equal((await fetch(base + "/api/content/" + saved.hash)).status, 200);
});

test("oracle refuses a contract whose immutable parameters differ from the hashed metadata", async () => {
  const saved = await (await post("/api/metadata", input)).json();
  const config = await (await fetch(base + "/api/config")).json();
  const rpc = provider();
  try {
    const factory = new Contract(config.factory, config.abi.CampaignFactory, await rpc.getSigner(1));
    const m = saved.metadata;
    await (await factory.createCampaign(saved.hash, m.goalWei, m.fundingDeadline, m.votingDuration + 60,
                                       m.submissionWindow, m.milestoneBps)).wait();
    const address = await factory.campaigns((await factory.campaignCount()) - 1n);
    const result = await post(`/api/campaigns/${address}/score`, {});
    assert.equal(result.status, 400);
    assert.match((await result.json()).error, /metadata mismatch/);
    const registry = new Contract(config.registry, config.abi.PredictionRegistry, rpc);
    assert.equal((await registry.predictions(address)).publishedAt, 0n);
  } finally { rpc.destroy(); }
});
