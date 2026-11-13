import fs from 'node:fs';
import { BrowserProvider, JsonRpcProvider, Wallet, ContractFactory, Contract, id, parseEther } from 'ethers';
import { artifact } from '../../server/chain.mjs';
import { saveContent, readContent, campaignMetadata } from '../../server/content.mjs';
export { Contract, id, parseEther, artifact, saveContent, readContent };
export const MODEL = id('StepFund-LR2-explicit-oracle-stub-v1');
export function writeReport(name, value) {
  fs.mkdirSync('reports/lab2',{recursive:true});
  fs.writeFileSync(`reports/lab2/${name}.json`,JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
}
export async function connect({ embedded=false }={}) {
  const sepolia=process.env.LAB2_NETWORK==='sepolia';
  let rpc,connection,roles;
  if(sepolia) {
    if(!process.env.SEPOLIA_RPC_URL)throw Error('Set SEPOLIA_RPC_URL in .env.sepolia');
    rpc=new JsonRpcProvider(process.env.SEPOLIA_RPC_URL,undefined,{cacheTimeout:-1});
    if((await rpc.getNetwork()).chainId!==11155111n)throw Error('Expected Sepolia chain 11155111');
    const names=['ADMIN','AUTHOR','BACKER_A','BACKER_B','ORACLE'];
    roles=names.map(name=>{
      const key=process.env[`SEPOLIA_${name}_KEY`] || (name==='ORACLE'?process.env.SEPOLIA_ADMIN_KEY:undefined);
      if(!key)throw Error(`Missing SEPOLIA_${name}_KEY; never paste keys into chat`);
      try { return new Wallet(key,rpc); } catch { throw Error(`Invalid SEPOLIA_${name}_KEY; its value is not printed`); }
    });
  } else {
    if(embedded) {
      const hre=(await import('hardhat')).default;connection=await hre.network.create('local');
      rpc=new BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});
    } else {
      const url=new URL(process.env.RPC_URL || 'http://127.0.0.1:8545');
      if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Use LAB2_NETWORK=sepolia for remote networks');
      rpc=new JsonRpcProvider(url.href,undefined,{cacheTimeout:-1});
    }
    if((await rpc.getNetwork()).chainId!==31337n)throw Error('Expected local chain 31337');
    roles=await Promise.all([0,1,2,3,4].map(i=>rpc.getSigner(i)));
  }
  const [admin,author,a,b,oracle]=roles;
  const addresses=await Promise.all([admin,author,a,b].map(s=>s.getAddress()));
  if(new Set(addresses).size!==4)throw Error('Admin, author and two backers must be distinct addresses');
  const chainId=Number((await rpc.getNetwork()).chainId);
  const receipts=[];
  async function record(action,transaction) {
    const receipt=await (await transaction).wait();
    if(!receipt || receipt.status!==1)throw Error(`Failed transaction: ${action}`);
    receipts.push({action,hash:receipt.hash,gasUsed:receipt.gasUsed.toString(),gasPriceWei:receipt.gasPrice.toString(),feeWei:receipt.fee.toString(),blockNumber:receipt.blockNumber});
    console.log(action,receipt.hash,'gas',receipt.gasUsed.toString());return receipt;
  }
  return {rpc,admin,author,a,b,oracle,sepolia,chainId,receipts,record,
    stateFile:`data/local/lab2-${chainId}.json`,
    async close(){if(connection)await connection.close();else rpc.destroy();}};
}
export async function deploy(ctx) {
  const create=async(name,args)=>{
    const bin=artifact(name);const c=await new ContractFactory(bin.abi,bin.bytecode,ctx.admin).deploy(...args);
    await ctx.record(`${name}.deployment`,c.deploymentTransaction());return c;
  };
  const registry=await create('PredictionRegistry',[await ctx.admin.getAddress()]);
  const factory=await create('CampaignFactory',[registry.target]);
  await ctx.record('PredictionRegistry.setFactory',registry.setFactory(factory.target));
  await ctx.record('PredictionRegistry.setOracle',registry.setOracle(await ctx.oracle.getAddress(),true));
  const manifestHash=saveContent({type:'oracle-stub',version:1,modelHash:MODEL,note:'Fixed test score; no ML model used in LR2'});
  await ctx.record('PredictionRegistry.registerModel',registry.registerModel(MODEL,`sqlite:${manifestHash}`));
  const state={chainId:ctx.chainId,registry:registry.target,factory:factory.target,modelHash:MODEL,
    createdAt:new Date().toISOString(),admin:await ctx.admin.getAddress(),author:await ctx.author.getAddress(),oracle:await ctx.oracle.getAddress()};
  fs.mkdirSync('data/local',{recursive:true});fs.writeFileSync(ctx.stateFile,JSON.stringify(state,null,2)+'\n');
  return {...state,registryContract:registry,factoryContract:factory};
}
export function load(ctx) {
  const state=JSON.parse(fs.readFileSync(ctx.stateFile,'utf8'));
  if(state.chainId!==ctx.chainId)throw Error('Deployment chain mismatch');
  return {...state,registryContract:new Contract(state.registry,artifact('PredictionRegistry').abi,ctx.admin),
    factoryContract:new Contract(state.factory,artifact('CampaignFactory').abi,ctx.author)};
}
export async function seed(ctx,state) {
  const now=Number((await ctx.rpc.getBlock('latest')).timestamp);
  const m=campaignMetadata({title:'StepFund LR2 demonstration',description:'A crowdfunding project used to demonstrate milestone voting and proportional refunds without machine learning.',
    goalEth:ctx.sepolia?'0.002':'10',budgetGoal:1000,durationDays:30,category:'Art',main_category:'Art',
    milestoneBps:[4000,6000],milestoneTitles:['Prototype','Delivery'],votingDuration:ctx.sepolia?120:60,submissionWindow:ctx.sepolia?86400:120},now);
  const hash=saveContent(m);
  const receipt=await ctx.record('CampaignFactory.createCampaign',state.factoryContract.connect(ctx.author).createCampaign(hash,m.goalWei,m.fundingDeadline,m.votingDuration,m.submissionWindow,m.milestoneBps));
  const event=receipt.logs.map(log=>{try{return state.factoryContract.interface.parseLog(log);}catch{return null;}}).find(log=>log?.name==='CampaignCreated');
  if(!event)throw Error('Missing CampaignCreated event');
  state.campaign=event.args.campaign;state.metadataHash=hash;state.seedTransactionHash=receipt.hash;
  const {registryContract,factoryContract,...saved}=state;fs.writeFileSync(ctx.stateFile,JSON.stringify(saved,null,2)+'\n');
  return state;
}
export async function oracleStub(ctx,state,score=7200) {
  const c=new Contract(state.campaign,artifact('Campaign').abi,ctx.author);
  const hash=await c.metadataHash(),value=readContent(hash);
  if(id((await import('../../server/content.mjs')).canonical(value))!==hash)throw Error('On-chain input hash mismatch');
  const now=Number((await ctx.rpc.getBlock('latest')).timestamp);
  const audit=saveContent({kind:'explicit-lr2-stub',scoreBps:score,modelHash:MODEL,inputHash:hash,chainId:ctx.chainId,campaign:state.campaign});
  await ctx.record('PredictionRegistry.publishPrediction',state.registryContract.connect(ctx.oracle).publishPrediction(state.campaign,score,hash,MODEL,audit,now+3600));
  return c;
}
export async function waitUntil(ctx,deadline) {
  if(!ctx.sepolia){const now=Number((await ctx.rpc.getBlock('latest')).timestamp);await ctx.rpc.send('evm_increaseTime',[Math.max(1,Number(deadline)-now+1)]);await ctx.rpc.send('evm_mine',[]);return;}
  console.log('Waiting for Sepolia deadline:',new Date(Number(deadline)*1000).toISOString());
  while(Number((await ctx.rpc.getBlock('latest')).timestamp)<Number(deadline))await new Promise(r=>setTimeout(r,12000));
}
