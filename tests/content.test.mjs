import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, campaignMetadata } from "../server/content.mjs";

const sample = { title: "A valid campaign", description: "A real project description with enough detail for the prediction.",
  goalEth: "1", budgetGoal: 10000, durationDays: 30, category: "Art", main_category: "Art",
  milestoneBps: [4000, 6000], milestoneTitles: ["Prototype", "Delivery"] };
test("canonical content hashing is independent of object key insertion order", () => {
  assert.equal(canonical({ b: [2, { z: "a", a: 1 }], a: "x" }), canonical({ a: "x", b: [2, { a: 1, z: "a" }] }));
});
test("metadata fixes deadlines and tranche proportions before on-chain creation", () => {
  const value = campaignMetadata(sample, 1000);
  assert.equal(value.goalWei, "1000000000000000000");
  assert.equal(value.fundingDeadline, 1000 + 30 * 86400);
  assert.deepEqual(value.milestoneBps, [4000, 6000]);
});
test("invalid financial parameters, title-only descriptions, and schedules are rejected", () => {
  for (const patch of [{ description: "Short" }, { goalEth: "-1" }, { budgetGoal: Infinity },
                       { milestoneBps: [4000, 5000] }, { durationDays: 0 }, { currency: "<x>" }]) {
    assert.throws(() => campaignMetadata({ ...sample, ...patch }, 1000));
  }
});
