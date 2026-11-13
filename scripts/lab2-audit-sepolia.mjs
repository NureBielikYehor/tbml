import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Interface, Wallet, formatEther, id } from 'ethers';
import { artifact, readContent, writeReport } from './lib/lab2.mjs';
import { canonical } from '../server/content.mjs';
const state = JSON.parse(fs.readFileSync('data/local/lab2-11155111.json','utf8'));
const run = JSON.parse(fs.readFileSync('reports/lab2/scenario-11155111.json','utf8'));
assert.equal(state.chainId,11155111);assert.equal(run.campaign,state.campaign);
const rpcUrl=process.env.SEPOLIA_RPC_URL;if(!rpcUrl)throw Error('Set SEPOLIA_RPC_URL locally');
let nextId=1;
async function batch(items) {
 const requests=items.map(([method,params])=>({jsonrpc:'2.0',id:nextId++,method,params}));
 const response=await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(requests),signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error(`RPC HTTP ${response.status}`);
 const data=await response.json();
 return requests.map(request=>{const value=data.find(item=>item.id===request.id);if(!value||value.error)throw Error(`RPC ${request.method} failed`);return value.result;});
}
const [chain]=await batch([['eth_chainId',[]]]);assert.equal(chain,'0xaa36a7');
const campaignAbi=new Interface(artifact('Campaign').abi),registryAbi=new Interface(artifact('PredictionRegistry').abi);
async function call(address,abi,name,args=[]) {
 const [value]=await batch([['eth_call',[{to:address,data:abi.encodeFunctionData(name,args)},'latest']]]);
 return abi.decodeFunctionResult(name,value);
}
const [balanceHex]=await batch([['eth_getBalance',[state.campaign,'latest']]]);
const fields={};
for(const name of ['state','goal','totalContributed','totalReleased','totalRefunded','authorCredit','refundPool','metadataHash'])fields[name]=(await call(state.campaign,campaignAbi,name))[0];
assert.equal(fields.state,5n);assert.equal(BigInt(balanceHex),0n);assert.equal(fields.goal,2000000000000000n);
assert.equal(fields.totalContributed,fields.goal);assert.equal(fields.totalReleased,800000000000000n);assert.equal(fields.totalRefunded,1200000000000000n);assert.equal(fields.authorCredit,0n);assert.equal(fields.refundPool,fields.totalRefunded);
assert.equal(id(canonical(readContent(fields.metadataHash))),fields.metadataHash);
const milestones=[];
for(let index=0;index<2;index++) {
 const m=await call(state.campaign,campaignAbi,'milestones',[index]);assert.equal(m.status,index===0?2n:3n);
 milestones.push({index,amountWei:m.amount.toString(),status:Number(m.status),yesWeight:m.yesWeight.toString(),noWeight:m.noWeight.toString(),reportHash:m.reportHash});
 // Validate the committed off-chain report as well as campaign metadata.
 readContent(m.reportHash);
}
const backers=[];
for(const [role,refundWei]of [['BACKER_A',720000000000000n],['BACKER_B',480000000000000n]]) {
 const key=process.env[`SEPOLIA_${role}_KEY`];if(!key)throw Error(`Missing ${role} key in local configuration`);
 const address=new Wallet(key).address;
 assert.equal((await call(state.campaign,campaignAbi,'refundClaimed',[address]))[0],true);
 assert.equal((await call(state.campaign,campaignAbi,'refundable',[address]))[0],0n);
 backers.push({role,address,refundWei:refundWei.toString()});
}
const prediction=await call(state.registry,registryAbi,'predictions',[state.campaign]);assert.equal(prediction.inputHash,fields.metadataHash);assert.equal(prediction.scoreBps,7200n);
readContent(prediction.auditHash);
const known=[{action:'CampaignFactory.createCampaign',hash:state.seedTransactionHash},...run.receipts];
const receipts=[];
for(let offset=0;offset<known.length;offset+=8) {
 const group=known.slice(offset,offset+8);const results=await batch(group.map(row=>['eth_getTransactionReceipt',[row.hash]]));
 for(let index=0;index<results.length;index++) {
  const r=results[index];assert(r&&r.status==='0x1');
  const gasUsed=BigInt(r.gasUsed),gasPriceWei=BigInt(r.effectiveGasPrice);
  receipts.push({...group[index],blockNumber:Number(BigInt(r.blockNumber)),status:1,gasUsed:gasUsed.toString(),gasPriceWei:gasPriceWei.toString(),feeWei:(gasUsed*gasPriceWei).toString()});
 }
}
const verification=JSON.parse(fs.readFileSync('reports/lab2/verification-sepolia.json','utf8'));assert.equal(verification.results.length,3);assert(verification.results.every(r=>r.verified));
const gas=receipts.reduce((n,r)=>n+BigInt(r.gasUsed),0n),fee=receipts.reduce((n,r)=>n+BigInt(r.feeWei),0n);
writeReport('sepolia-validation',{checkedAt:new Date().toISOString(),chainId:11155111,campaign:state.campaign,registry:state.registry,factory:state.factory,passed:true,
 state:'Refunding',goalWei:fields.goal,collectedWei:fields.totalContributed,releasedWei:fields.totalReleased,refundedWei:fields.totalRefunded,balanceWei:BigInt(balanceHex),authorCreditWei:fields.authorCredit,
 milestones,backers,oracle:{kind:'explicit LR2 stub, no ML',scoreBps:Number(prediction.scoreBps),inputHash:prediction.inputHash,modelHash:prediction.modelHash,auditHash:prediction.auditHash},
 gas,feeWei:fee,feeEth:formatEther(fee),receipts,verification:verification.results,
 note:'Public-network receipts include campaign creation through final refunds and exclude shared registry/factory deployment. Sepolia gas values and fees are distinct from local Hardhat measurements.'});
console.log('PASS: independently audited Sepolia state, both milestones, all scenario receipts, off-chain hashes, refunds and zero escrow balance.');
console.log('Collected:',formatEther(fields.totalContributed),'released:',formatEther(fields.totalReleased),'refunded:',formatEther(fields.totalRefunded),'Sepolia ETH; escrow: 0.');
