import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id } from 'ethers';
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'stepfund-storage-'));
process.env.CONTENT_DB=path.join(folder,'content.sqlite3');
const {saveContent,readContent,canonical}=await import('../server/content.mjs');
test('SQLite content matches the canonical on-chain commitment',()=>{
 const value={description:'Original report',stage:1};const hash=saveContent(value);
 assert.equal(hash,id(canonical(value)));assert.deepEqual(readContent(hash),value);
 assert.equal(saveContent({stage:1,description:'Original report'}),hash);
});
test('Substituted database content is rejected and the original remains recoverable',()=>{
 const value={stage:2,description:'Original second report'};const hash=saveContent(value);
 const db=new DatabaseSync(process.env.CONTENT_DB);const original=db.prepare('SELECT body FROM content WHERE hash=?').get(hash).body;
 try {db.prepare('UPDATE content SET body=? WHERE hash=?').run('{}',hash);assert.throws(()=>readContent(hash),/integrity/);
  db.prepare('UPDATE content SET body=? WHERE hash=?').run(original+'\n',hash);assert.throws(()=>readContent(hash),/integrity/);}
 finally {db.prepare('UPDATE content SET body=? WHERE hash=?').run(original,hash);db.close();}
 assert.deepEqual(readContent(hash),value);
});
test('Invalid paths and unknown commitments cannot read arbitrary files',()=>{
 for(const input of ['../package.json','0x00','x'.repeat(66)])assert.throws(()=>readContent(input),/Invalid content hash/);
 assert.throws(()=>readContent(id('missing')),/not found/);
});
