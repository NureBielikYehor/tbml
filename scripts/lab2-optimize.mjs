import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import assert from 'node:assert/strict';
import { ContractFactory, Contract, id } from 'ethers';
import { connect,writeReport } from './lib/lab2.mjs';
const current=fs.readFileSync('contracts/Campaign.sol','utf8');
function nestedVotes(source) {
 return source.replace('mapping(address => uint256) private _voteBitmap;', 'mapping(uint256 => mapping(address => bool)) private _votes;')
  .replace('return index < milestones.length && (_voteBitmap[backer] & (uint256(1) << index)) != 0;','return index < milestones.length && _votes[index][backer];')
  .replace('_voteBitmap[msg.sender] |= uint256(1) << currentMilestone;','_votes[currentMilestone][msg.sender] = true;');
}
const packedNested=nestedVotes(current);
const unpacked=packedNested.replace('uint128 amount;\n        uint64 voteDeadline;\n        MilestoneStatus status;\n        uint128 yesWeight;\n        uint128 noWeight;\n        bytes32 reportHash;',
 'uint256 amount;\n        bytes32 reportHash;\n        uint64 voteDeadline;\n        uint256 yesWeight;\n        uint256 noWeight;\n        MilestoneStatus status;')
 .replace('Milestone(uint128(amount), 0, MilestoneStatus.Pending, 0, 0, bytes32(0))','Milestone(amount, bytes32(0), 0, 0, 0, MilestoneStatus.Pending)');
assert.notEqual(unpacked,packedNested);assert.notEqual(packedNested,current);
function compile(source) {
 const sources=Object.fromEntries(fs.readdirSync('contracts').filter(x=>x.endsWith('.sol')).map(x=>[`contracts/${x}`,{content:x==='Campaign.sol'?source:fs.readFileSync(`contracts/${x}`,'utf8')}]));
 const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
 const output=JSON.parse(solc.compile(JSON.stringify(input),{import:name=>{try{return{contents:fs.readFileSync(name.startsWith('@')?path.join('node_modules',name):name,'utf8')}}catch{return{error:name}}}}));
 if(output.errors?.some(e=>e.severity==='error'))throw Error(output.errors.map(e=>e.formattedMessage).join('\n'));
 return Object.fromEntries(Object.values(output.contracts).flatMap(contracts=>Object.entries(contracts).map(([name,c])=>[name,{abi:c.abi,bytecode:'0x'+c.evm.bytecode.object}])));
}
const ctx=await connect({embedded:true});
const cases=[];
try {
 let snapshot=await ctx.rpc.send('evm_snapshot',[]);
 for(const [name,source]of[['unpacked+nested',unpacked],['packed+nested',packedNested],['packed+bitmap',current]]) {
  await ctx.rpc.send('evm_revert',[snapshot]);snapshot=await ctx.rpc.send('evm_snapshot',[]);
  const bins=compile(source),receipts=[];
  const tx=async(label,p)=>{const r=await(await p).wait();receipts.push({action:label,gas:Number(r.gasUsed)});};
  async function deploy(name,args){const c=await new ContractFactory(bins[name].abi,bins[name].bytecode,ctx.admin).deploy(...args);await c.waitForDeployment();return c;}
  const registry=await deploy('PredictionRegistry',[await ctx.admin.getAddress()]);const factory=await deploy('CampaignFactory',[registry.target]);
  await(await registry.setFactory(factory.target)).wait();await(await registry.setOracle(await ctx.oracle.getAddress(),true)).wait();await(await registry.registerModel(id('model'),'fixture')).wait();
  const now=Number((await ctx.rpc.getBlock('latest')).timestamp);
  await tx('create',factory.connect(ctx.author).createCampaign(id('input'),1000000,now+3600,60,120,[4000,6000]));
  const campaign=new Contract(await factory.campaigns(0),bins.Campaign.abi,ctx.author);
  await tx('predict',registry.connect(ctx.oracle).publishPrediction(campaign.target,7000,id('input'),id('model'),id('audit'),now+1000));
  await tx('start',campaign.startFunding());await tx('fundA',campaign.connect(ctx.a).contribute({value:600000}));await tx('fundB',campaign.connect(ctx.b).contribute({value:400000}));
  for(let i=1;i<=2;i++) {
   await tx('report'+i,campaign.submitReport(id('report')));await tx('voteA'+i,campaign.connect(ctx.a).vote(i===1));await tx('voteB'+i,campaign.connect(ctx.b).vote(i===1));
   await ctx.rpc.send('evm_increaseTime',[61]);await ctx.rpc.send('evm_mine',[]);await tx('finalize'+i,campaign.finalizeMilestone());
   if(i===1)await tx('payout',campaign.withdrawPayout(await ctx.author.getAddress()));
  }
  await tx('refundA',campaign.connect(ctx.a).claimRefund(await ctx.a.getAddress()));await tx('refundB',campaign.connect(ctx.b).claimRefund(await ctx.b.getAddress()));
  assert.equal(await ctx.rpc.getBalance(campaign.target),0n);assert.equal(await campaign.totalReleased(),400000n);assert.equal(await campaign.totalRefunded(),600000n);
  cases.push({name,totalGas:receipts.reduce((n,r)=>n+r.gas,0),receipts});console.log(name,cases.at(-1).totalGas);
 }
 const optimizations=[{name:'Pack milestone amounts, deadlines, status and voting weights into fewer storage slots',before:cases[0].totalGas,after:cases[1].totalGas},
 {name:'Store per-backer milestone votes as a bitmap instead of a nested mapping',before:cases[1].totalGas,after:cases[2].totalGas}].map(x=>({...x,saved:x.before-x.after,savedPercent:100*(x.before-x.after)/x.before}));
 assert(optimizations.every(x=>x.saved>0));
 writeReport('optimizations',{executedAt:new Date().toISOString(),compiler:solc.version(),settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'cancun'},method:'Each variant executes the same scenario from the same EVM snapshot (same timestamps, accounts, addresses and nonce). Assertions check payout/refund conservation.',cases,optimizations});
 console.log('PASS: both code optimizations reduce total scenario gas');
}finally{await ctx.close();}
