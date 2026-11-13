import assert from 'node:assert/strict';
import { connect,deploy,load,seed,oracleStub,waitUntil,Contract,artifact,writeReport,saveContent } from './lib/lab2.mjs';
const ctx=await connect({embedded:process.env.LAB2_NETWORK!=='sepolia' && !process.argv.includes('--deployed')});
try {
  const state=process.argv.includes('--deployed')?load(ctx):await seed(ctx,await deploy(ctx));
  const c=new Contract(state.campaign,artifact('Campaign').abi,ctx.author);
  // Permit resuming after an interrupted public-network run.
  if(await c.state()===0n){await oracleStub(ctx,state);await ctx.record('Campaign.startFunding',c.startFunding());}
  const goal=await c.goal();const amountA=goal*6n/10n;const amountB=goal-amountA;
  if(await c.state()===1n) {
    if(await c.contributions(await ctx.a.getAddress())===0n)await ctx.record('Campaign.contribute.A',c.connect(ctx.a).contribute({value:amountA}));
    if(await c.contributions(await ctx.b.getAddress())===0n)await ctx.record('Campaign.contribute.B',c.connect(ctx.b).contribute({value:amountB}));
  }
  if(await c.authorCredit()>0n)await ctx.record('Campaign.withdrawPayout.resume',c.withdrawPayout(await ctx.author.getAddress()));
  for(let i=Number(await c.currentMilestone());i<2 && [2n,3n].includes(await c.state());i++) {
    if(await c.state()===2n){const hash=saveContent({stage:i+1,body:i===0?'Prototype is complete.':'Delivery failed to meet the requirements.'});await ctx.record(`Campaign.submitReport.${i+1}`,c.submitReport(hash));}
    const m=await c.milestones(i);
    if(Number((await ctx.rpc.getBlock('latest')).timestamp)<Number(m.voteDeadline)) {
      for(const [label,signer]of[['A',ctx.a],['B',ctx.b]])if(!await c.hasVoted(i,await signer.getAddress()))await ctx.record(`Campaign.vote.${i+1}.${label}`,c.connect(signer).vote(i===0));
    }
    await waitUntil(ctx,m.voteDeadline);
    await ctx.record(`Campaign.finalizeMilestone.${i+1}`,c.finalizeMilestone());
    if(i===0){assert.equal(await c.totalReleased(),goal*4n/10n);await ctx.record('Campaign.withdrawPayout',c.withdrawPayout(await ctx.author.getAddress()));}
  }
  assert.equal(await c.state(),5n);
  const expectedA=(goal-goal*4n/10n)*6n/10n;
  const expectedB=goal-goal*4n/10n-expectedA;
  for(const [label,signer,expected]of[['A',ctx.a,expectedA],['B',ctx.b,expectedB]]) {
    if(!await c.refundClaimed(await signer.getAddress())) {
      assert.equal(await c.refundable(await signer.getAddress()),expected);
      await ctx.record(`Campaign.claimRefund.${label}`,c.connect(signer).claimRefund(await signer.getAddress()));
    }
  }
  assert.equal(await ctx.rpc.getBalance(c.target),0n);
  writeReport(`scenario-${ctx.chainId}`,{executedAt:new Date().toISOString(),chainId:ctx.chainId,campaign:c.target,oracle:'fixed-score stub, no ML',
    collectedWei:goal,releasedWei:await c.totalReleased(),refundedWei:await c.totalRefunded(),refundAWei:expectedA,refundBWei:expectedB,balanceWei:'0',receipts:ctx.receipts});
  console.log('PASS: first tranche paid, second rejected, remaining funds refunded; escrow balance = 0');
}finally{await ctx.close();}
