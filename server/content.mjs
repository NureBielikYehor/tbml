import fs from "node:fs";
import { id, parseEther } from "ethers";

const folder = "data/local/content";
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function saveContent(value) {
  const text = canonical(value), hash = id(text);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(`${folder}/${hash.slice(2)}.json`, text);
  return hash;
}
export function readContent(hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid content hash");
  const value = JSON.parse(fs.readFileSync(`${folder}/${hash.slice(2).toLowerCase()}.json`, "utf8"));
  if (id(canonical(value)).toLowerCase() !== hash.toLowerCase()) throw new Error("Content integrity check failed");
  return value;
}
function text(value, min, max) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw new Error("Invalid text length");
  return value.trim();
}
function integer(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error("Invalid numeric parameter");
  return number;
}
export function campaignMetadata(input, blockTime) {
  const goalWei = parseEther(String(input.goalEth));
  if (goalWei <= 0n || goalWei > 2n ** 128n - 1n) throw new Error("Invalid funding goal");
  const budgetGoal = Number(input.budgetGoal);
  if (!Number.isFinite(budgetGoal) || budgetGoal <= 0 || budgetGoal > 1e12) throw new Error("Invalid budget goal");
  const durationDays = integer(input.durationDays, 1, 90);
  const bps = input.milestoneBps;
  if (!Array.isArray(bps) || bps.length < 1 || bps.length > 20) throw new Error("Invalid milestones");
  const milestoneBps = bps.map(value => integer(value, 1, 10000));
  if (milestoneBps.reduce((a, b) => a + b, 0) !== 10000) throw new Error("Milestones must sum to 100%");
  if (!Array.isArray(input.milestoneTitles) || input.milestoneTitles.length !== bps.length) throw new Error("Missing milestone titles");
  const currency = text(input.currency || "USD", 3, 3).toUpperCase();
  const country = text(input.country || "US", 2, 2).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || !/^[A-Z]{2}$/.test(country)) throw new Error("Invalid currency or country");
  return {
    type: "campaign", version: 1, title: text(input.title, 3, 120), description: text(input.description, 30, 20000),
    category: text(input.category, 1, 100), main_category: text(input.main_category, 1, 100), currency, country,
    goalWei: goalWei.toString(), budgetGoal, durationDays,
    launchAt: new Date(blockTime * 1000).toISOString(), fundingDeadline: blockTime + durationDays * 86400,
    votingDuration: integer(input.votingDuration ?? 3600, 60, 30 * 86400),
    submissionWindow: integer(input.submissionWindow ?? 7 * 86400, 60, 90 * 86400),
    milestoneBps, milestoneTitles: input.milestoneTitles.map(value => text(value, 2, 200)),
  };
}
