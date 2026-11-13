import fs from 'node:fs';
import { Wallet } from 'ethers';
const filename='.env.sepolia';
if(!process.argv.includes('--create'))throw Error('Run npm run lab2:wallets -- --create to create fresh test-only accounts locally. Existing .env.sepolia is never overwritten.');
const wallets=Object.fromEntries(['ADMIN','AUTHOR','BACKER_A','BACKER_B','ORACLE'].map(role=>[role,Wallet.createRandom()]));
const content=['# Test-only accounts. Never send these keys in chat or commit this file.','LAB2_NETWORK=sepolia','SEPOLIA_RPC_URL=','ETHERSCAN_API_KEY=',
 ...Object.entries(wallets).flatMap(([role,w])=>[`# ${role}: ${w.address}`,`SEPOLIA_${role}_KEY=${w.privateKey}`]),''].join('\n');
fs.writeFileSync(filename,content,{mode:0o600,flag:'wx'});
console.log('Created .env.sepolia with permissions 0600. Only public addresses are shown:');
for(const [role,w]of Object.entries(wallets))console.log(role,w.address);
console.log('Use a Sepolia faucet for ADMIN, AUTHOR, BACKER_A, BACKER_B and ORACLE. No real ETH is required. Set SEPOLIA_RPC_URL and ETHERSCAN_API_KEY locally.');
