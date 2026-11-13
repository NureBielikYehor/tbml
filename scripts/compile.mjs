import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const sources = Object.fromEntries(fs.readdirSync("contracts").filter(x => x.endsWith(".sol"))
  .map(name => [`contracts/${name}`, { content: fs.readFileSync(`contracts/${name}`, "utf8") }]));
const buildInput = {
  language: "Solidity", sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } },
};
const result = JSON.parse(solc.compile(JSON.stringify(buildInput), { import: name => {
  const location = name.startsWith("@") ? path.join("node_modules", name) : name;
  try { return { contents: fs.readFileSync(location, "utf8") }; }
  catch { return { error: `Cannot resolve ${name}` }; }
} }));
for (const error of result.errors ?? []) process.stderr.write(`${error.formattedMessage}\n`);
if (result.errors?.some(x => x.severity === "error")) process.exit(1);
fs.mkdirSync("artifacts", { recursive: true });
const verificationInput = { ...buildInput, sources: Object.fromEntries(Object.keys(result.sources).map(name => [name,
  { content: sources[name]?.content ?? fs.readFileSync(name.startsWith("@") ? path.join("node_modules", name) : name, "utf8") }])) };
fs.writeFileSync("artifacts/build-input.json", JSON.stringify(verificationInput, null, 2));
for (const [source, contracts] of Object.entries(result.contracts)) {
  if (!source.startsWith("contracts/")) continue;
  for (const [name, contract] of Object.entries(contracts)) {
    if (!contract.evm.bytecode.object) continue;
    const bytes = contract.evm.deployedBytecode.object.length / 2;
    if (bytes > 24576) throw new Error(`${name} exceeds EIP-170: ${bytes} bytes`);
    fs.writeFileSync(`artifacts/${name}.json`, JSON.stringify({
      name, abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecodeBytes: bytes, compiler: solc.version(),
    }, null, 2));
    console.log(`${name}: ${bytes} deployed bytes`);
  }
}
