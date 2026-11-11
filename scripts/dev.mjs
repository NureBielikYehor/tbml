import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { provider, deployContracts } from "../server/chain.mjs";

const children = [];
function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push(child); return child;
}
function close() { for (const child of children) child.kill("SIGTERM"); }
process.on("SIGINT", () => { close(); process.exit(0); });
process.on("SIGTERM", () => { close(); process.exit(0); });
const rpcURL = new URL(process.env.RPC_URL || "http://127.0.0.1:8545");
const rpcPort = Number(rpcURL.port || 8545);
for (const port of [rpcPort, Number(process.env.PORT || 3000)]) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is already in use; stop the previous local instance first`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
const compile = start(process.execPath, ["scripts/compile.mjs"]);
const [code] = await once(compile, "exit");
if (code !== 0) process.exit(code || 1);
const chain = start(process.execPath, ["node_modules/hardhat/dist/src/cli.js", "node", "--hostname", "127.0.0.1", "--port", String(rpcPort)], { stdio: "ignore" });
const rpc = provider();
let ready = false;
for (let i = 0; i < 100; i++) {
  if (chain.exitCode !== null) { close(); throw new Error("Local chain failed to start; port 8545 may be in use"); }
  try { await rpc.getBlockNumber(); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
}
if (!ready) { close(); throw new Error("Local chain did not become ready"); }
await deployContracts(rpc); rpc.destroy();
const server = start(process.execPath, ["--env-file-if-exists=.env", "server/index.mjs"]);
server.on("exit", () => close());
