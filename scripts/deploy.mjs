import { provider, deployContracts } from "../server/chain.mjs";
const rpc = provider();
try { console.log(JSON.stringify(await deployContracts(rpc), null, 2)); }
finally { rpc.destroy(); }
