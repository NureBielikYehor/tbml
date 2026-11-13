import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {connect,deploy,seed,Contract,artifact,readContent,writeReport} from './lib/lab2.mjs';
import {contentDatabasePath} from '../server/content.mjs';
const ctx=await connect({embedded:true});
try {
 const state=await seed(ctx,await deploy(ctx));
 const c=new Contract(state.campaign,artifact('Campaign').abi,ctx.author);const hash=await c.metadataHash();
 assert.equal(readContent(hash).type,'campaign');console.log('PASS: SQLite file matches on-chain hash',hash);
 const db=new DatabaseSync(contentDatabasePath());const original=db.prepare('SELECT body FROM content WHERE hash=?').get(hash).body;
 try{db.prepare('UPDATE content SET body=? WHERE hash=?').run('{}',hash);assert.throws(()=>readContent(hash),/integrity/);console.log('PASS: substituted file rejected');}
 finally{db.prepare('UPDATE content SET body=? WHERE hash=?').run(original,hash);db.close();}
 writeReport('integrity',{executedAt:new Date().toISOString(),campaign:c.target,onChainHash:hash,authentic:true,tamperedRejected:true,originalRestored:true});
}finally{await ctx.close();}
