import { parseEther, formatEther } from 'ethers';
import { connect, writeReport } from './lib/lab2.mjs';
const ctx = await connect();
try {
  if (!ctx.sepolia || ctx.chainId !== 11155111) throw Error('Funding helper is restricted to the Sepolia test network');
  const target = parseEther('0.005');
  const plan = [];
  const seen = new Set([(await ctx.admin.getAddress()).toLowerCase()]);
  for (const [role, signer] of [['AUTHOR', ctx.author], ['BACKER_A', ctx.a], ['BACKER_B', ctx.b], ['ORACLE', ctx.oracle]]) {
    const address = await signer.getAddress();
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    const balance = await ctx.rpc.getBalance(address);
    plan.push({ role, address, currentWei: balance, topUpWei: balance < target ? target - balance : 0n });
  }
  const adminBalance = await ctx.rpc.getBalance(await ctx.admin.getAddress());
  const total = plan.reduce((n, item) => n + item.topUpWei, 0n);
  console.log('Test network:', ctx.chainId, 'Admin balance:', formatEther(adminBalance), 'Sepolia ETH');
  for (const item of plan) console.log(item.role, item.address, 'top-up:', formatEther(item.topUpWei), 'Sepolia ETH');
  if (process.argv.includes('--dry-run')) console.log('Dry run; no transactions submitted.');
  else {
    if (adminBalance < total + parseEther('0.001')) throw Error('Receive faucet test ETH first; keep at least 0.001 Sepolia ETH for deployment and transaction fees');
    for (const item of plan) if (item.topUpWei > 0n) await ctx.record(`fund.${item.role}`, ctx.admin.sendTransaction({ to: item.address, value: item.topUpWei }));
    writeReport('funding-sepolia', { executedAt: new Date().toISOString(), chainId: ctx.chainId, plan, receipts: ctx.receipts });
  }
} finally { await ctx.close(); }
