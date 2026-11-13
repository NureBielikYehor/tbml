import {connect,load,seed} from './lib/lab2.mjs';
const ctx=await connect();try{const state=await seed(ctx,load(ctx));console.log('Campaign:',state.campaign);}finally{await ctx.close();}
