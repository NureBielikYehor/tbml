import {connect,deploy,writeReport} from './lib/lab2.mjs';
const ctx=await connect();
try{const state=await deploy(ctx);const {registryContract,factoryContract,...saved}=state;writeReport(`deployment-${ctx.chainId}`,{...saved,receipts:ctx.receipts});console.log('Deployment saved:',ctx.stateFile);}
finally{await ctx.close();}
