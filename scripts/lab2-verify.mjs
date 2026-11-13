import fs from 'node:fs';
import { AbiCoder } from 'ethers';
import { artifact,readContent,writeReport } from './lib/lab2.mjs';
const local=process.argv.includes('--local');
if(local && !process.argv.includes('--prepare-only'))throw Error('Local verification only supports --prepare-only');
const state=JSON.parse(fs.readFileSync(`data/local/lab2-${local?31337:11155111}.json`,'utf8'));
const input=JSON.parse(fs.readFileSync('artifacts/build-input.json','utf8'));
const compiler='v'+artifact('CampaignFactory').compiler.match(/^\d+\.\d+\.\d+\+commit\.[a-f0-9]+/)[0];
const targets=[['PredictionRegistry',state.registry,[state.admin]],['CampaignFactory',state.factory,[state.registry]]];
if(state.campaign) {
 const m=readContent(state.metadataHash);
 targets.push(['Campaign',state.campaign,[state.author,state.registry,state.metadataHash,m.goalWei,m.fundingDeadline,m.votingDuration,m.submissionWindow,m.milestoneBps]]);
}
const requests=targets.map(([name,address,args])=>{
 const constructor=artifact(name).abi.find(x=>x.type==='constructor');
 return {chainid:'11155111',module:'contract',action:'verifysourcecode',contractaddress:address,
  sourceCode:JSON.stringify(input),codeformat:'solidity-standard-json-input',contractname:`contracts/${name}.sol:${name}`,
  compilerversion:compiler,optimizationUsed:'1',runs:'200',constructorArguments:AbiCoder.defaultAbiCoder().encode(constructor.inputs.map(x=>x.type),args).slice(2),evmVersion:'cancun',licenseType:'3'};
});
writeReport('verification-inputs',{preparedAt:new Date().toISOString(),network:local?'local dry-run':'sepolia',requests});
if(process.argv.includes('--prepare-only'))console.log('Prepared standard JSON and constructor arguments for',requests.length,'contracts. No request sent.');
else {
 if(!process.env.ETHERSCAN_API_KEY)throw Error('Set ETHERSCAN_API_KEY locally in .env.sepolia');
 async function api(params){const endpoint=new URL('https://api.etherscan.io/v2/api');endpoint.searchParams.set('chainid','11155111');endpoint.searchParams.set('apikey',process.env.ETHERSCAN_API_KEY);const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,apikey:process.env.ETHERSCAN_API_KEY})});if(!response.ok)throw Error('Explorer HTTP '+response.status);return response.json();}
 const results=[];
 for(const request of requests) {
  const submitted=await api(request);let status=submitted;
  if(submitted.status==='1') {
   const guid=submitted.result;
   for(let i=0;i<20;i++) {
    await new Promise(r=>setTimeout(r,3000));status=await api({chainid:'11155111',module:'contract',action:'checkverifystatus',guid});
    if(!/pending|queue/i.test(status.result))break;
   }
  }
  const verified=/already verified|pass - verified|successfully verified/i.test(status.result);
  const value={address:request.contractaddress,contract:request.contractname,verified,status:status.result,url:`https://sepolia.etherscan.io/address/${request.contractaddress}#code`};results.push(value);
  console.log(value.contract,value.verified?'VERIFIED':value.status,value.url);
  writeReport('verification-sepolia',{executedAt:new Date().toISOString(),results});
 }
 if(results.some(x=>!x.verified))throw Error('Not all contracts have been verified; see local verification-sepolia.json');
}
