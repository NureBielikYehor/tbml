import {connect,load,oracleStub} from './lib/lab2.mjs';
const ctx=await connect();try{await oracleStub(ctx,load(ctx),Number(process.env.STUB_SCORE_BPS||7200));}finally{await ctx.close();}
