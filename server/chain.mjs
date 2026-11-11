import fs from "node:fs";
import { Contract, ContractFactory, JsonRpcProvider } from "ethers";

export function artifact(name) { return JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8")); }
export function provider() {
  const url = new URL(process.env.RPC_URL || "http://127.0.0.1:8545");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("The unlocked-account demo only accepts a localhost RPC");
  return new JsonRpcProvider(url.href, undefined, { cacheTimeout: -1 });
}
export async function requireLocalChain(rpc) {
  if ((await rpc.getNetwork()).chainId !== 31337n) throw new Error("This development workflow requires local chain 31337");
}
export function deployment() {
  if (!fs.existsSync("data/local/deployment.json")) throw new Error("Deploy contracts first: npm run deploy");
  return JSON.parse(fs.readFileSync("data/local/deployment.json", "utf8"));
}
export async function deployContracts(rpc) {
  await requireLocalChain(rpc);
  const admin = await rpc.getSigner(0);
  const oracle = await rpc.getSigner(4);
  const r = artifact("PredictionRegistry");
  const registry = await new ContractFactory(r.abi, r.bytecode, admin).deploy(await admin.getAddress());
  await registry.waitForDeployment();
  const f = artifact("CampaignFactory");
  const factory = await new ContractFactory(f.abi, f.bytecode, admin).deploy(registry.target);
  await factory.waitForDeployment();
  await (await registry.setFactory(factory.target)).wait();
  await (await registry.setOracle(await oracle.getAddress(), true)).wait();
  const result = { chainId: 31337, registry: registry.target, factory: factory.target,
    admin: await admin.getAddress(), oracle: await oracle.getAddress(), deployedAt: new Date().toISOString() };
  fs.mkdirSync("data/local", { recursive: true });
  fs.writeFileSync("data/local/deployment.json", JSON.stringify(result, null, 2));
  return result;
}
export function contract(name, address, runner) { return new Contract(address, artifact(name).abi, runner); }
export function jsonSafe(value) { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)); }
