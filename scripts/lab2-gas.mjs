import fs from 'node:fs';
import assert from 'node:assert/strict';
import solc from 'solc';
import { ContractFactory, Contract, JsonRpcSigner, id } from 'ethers';
import { connect, artifact, writeReport } from './lib/lab2.mjs';
const ctx=await connect({embedded:true});
const rows=[];
async function measure(name,transaction,expectedStatus=1) {
 let receipt;try{receipt=await(await transaction).wait();}catch(e){receipt=e.receipt;if(!receipt)throw e;}
 assert.equal(receipt.status,expectedStatus,name);
 rows.push({function:name,gasUsed:Number(receipt.gasUsed),status:receipt.status,hash:receipt.hash});return receipt;
}
async function create(name,args,runner=ctx.admin,label=`${name}.deployment`) {
 const bin=artifact(name);const value=await new ContractFactory(bin.abi,bin.bytecode,runner).deploy(...args);
 await measure(label,value.deploymentTransaction());return value;
}
async function advance(seconds){await ctx.rpc.send('evm_increaseTime',[seconds]);await ctx.rpc.send('evm_mine',[]);}
const now=async()=>Number((await ctx.rpc.getBlock('latest')).timestamp);
const metadata=id('gas-input'),model=id('gas-model'),audit=id('gas-audit');
try {
 const registry=await create('PredictionRegistry',[await ctx.admin.getAddress()]);
 const factory=await create('CampaignFactory',[registry.target]);
 await measure('PredictionRegistry.setFactory',registry.setFactory(factory.target));
 await measure('PredictionRegistry.setOracle',registry.setOracle(await ctx.oracle.getAddress(),true));
 await measure('PredictionRegistry.registerModel',registry.registerModel(model,'sqlite:gas-fixture'));
 await measure('PredictionRegistry.setModelEnabled',registry.setModelEnabled(model,false));
 await(await registry.setModelEnabled(model,true)).wait();
 await measure('PredictionRegistry.setPaused',registry.setPaused(true));await(await registry.setPaused(false)).wait();
 await measure('PredictionRegistry.rotateOracle',registry.rotateOracle(await ctx.oracle.getAddress(),await ctx.b.getAddress()));
 await(await registry.rotateOracle(await ctx.b.getAddress(),await ctx.oracle.getAddress())).wait();
 const direct=await create('Campaign',[await ctx.author.getAddress(),registry.target,metadata,1000000,await now()+3600,60,120,[4000,6000]],ctx.author);
 await ctx.rpc.send('hardhat_impersonateAccount',[factory.target]);await ctx.rpc.send('hardhat_setBalance',[factory.target,'0x56BC75E2D63100000']);
 const factorySigner=new JsonRpcSigner(ctx.rpc,factory.target);
 await measure('PredictionRegistry.registerCampaign',registry.connect(factorySigner).registerCampaign(direct.target));
 await ctx.rpc.send('hardhat_stopImpersonatingAccount',[factory.target]);
 async function campaign() {
  const receipt=await measure('CampaignFactory.createCampaign',factory.connect(ctx.author).createCampaign(metadata,1000000,await now()+3600,60,120,[4000,6000]));
  const event=receipt.logs.map(l=>{try{return factory.interface.parseLog(l);}catch{return null;}}).find(l=>l?.name==='CampaignCreated');
  return new Contract(event.args.campaign,artifact('Campaign').abi,ctx.author);
 }
 async function start(c) {
  await measure('PredictionRegistry.publishPrediction',registry.connect(ctx.oracle).publishPrediction(c.target,7200,metadata,model,audit,await now()+1000));
  await measure('Campaign.startFunding',c.startFunding());
 }
 async function fund(c) {await start(c);await measure('Campaign.contribute.A',c.connect(ctx.a).contribute({value:600000}));await measure('Campaign.contribute.B',c.connect(ctx.b).contribute({value:400000}));}
 async function vote(c,support,index) {
  await measure('Campaign.submitReport',c.submitReport(audit));
  await measure(`Campaign.vote.stage${index}.A`,c.connect(ctx.a).vote(support));await measure(`Campaign.vote.stage${index}.B`,c.connect(ctx.b).vote(support));
  await advance(61);await measure('Campaign.finalizeMilestone',c.finalizeMilestone());
 }
 const c=await campaign();const scenarioStart=rows.length-1;await fund(c);await vote(c,true,1);await measure('Campaign.withdrawPayout',c.withdrawPayout(await ctx.author.getAddress()));
 await vote(c,false,2);await measure('Campaign.claimRefund.A',c.connect(ctx.a).claimRefund(await ctx.a.getAddress()));await measure('Campaign.claimRefund.B',c.connect(ctx.b).claimRefund(await ctx.b.getAddress()));
 const scenario=rows.slice(scenarioStart),scenarioGas=scenario.reduce((sum,r)=>sum+r.gasUsed,0);
 const draft=await campaign();await measure('Campaign.cancelDraft',draft.cancelDraft());
 const unmet=await campaign();await start(unmet);await measure('Campaign.contribute.partial',unmet.connect(ctx.a).contribute({value:100}));await advance(3601);await measure('Campaign.finalizeFunding',unmet.finalizeFunding());
 const inactive=await campaign();await fund(inactive);await advance(121);await measure('Campaign.expireSubmission',inactive.expireSubmission());
 await measure('PredictionRegistry.transferOwnership',registry.transferOwnership(await ctx.a.getAddress()));
 await measure('PredictionRegistry.acceptOwnership',registry.connect(ctx.a).acceptOwnership());
 const allFunctions=Object.fromEntries(['Campaign','CampaignFactory','PredictionRegistry'].map(name=>[name,artifact(name).abi.filter(x=>x.type==='function'&&['nonpayable','payable'].includes(x.stateMutability)).map(x=>x.name)]));
 const missing=Object.entries(allFunctions).flatMap(([contract,names])=>names.filter(name=>!rows.some(r=>r.function.startsWith(`${contract}.${name}`))).map(name=>`${contract}.${name}`));assert.deepEqual(missing,[]);
 const scenarioCost=gasGwei=>({gasGwei,gas:scenarioGas,eth:scenarioGas*gasGwei*1e-9});
 writeReport('gas',{executedAt:new Date().toISOString(),chainId:31337,compiler:solc.version(),settings:{optimizer:true,runs:200,viaIR:true,evmVersion:'cancun'},rows,allFunctions,
  scenario:{note:'Campaign creation through final refunds; excludes shared registry/factory deployment and admin setup',gas:scenarioGas,transactions:scenario,prices:[scenarioCost(5),scenarioCost(50)]},
  notes:['registerCampaign is measured with a locally impersonated factory as an isolated transaction; createCampaign already includes its internal cost.','renounceOwnership is a disabled view function and has no successful state-changing path.','Numbers are local EVM gas, not Sepolia confirmation-time measurements.']});
 console.log('PASS: gas measured for every mutating ABI function and all deployments; scenario gas =',scenarioGas);
}finally{await ctx.close();}
