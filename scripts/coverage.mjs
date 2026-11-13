import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.mkdirSync('reports/lab2', { recursive: true });
const run = spawnSync('.tools/bin/forge', ['coverage','--ir-minimum','--exclude-tests','--no-match-coverage','tests/','--report','summary','--report','lcov','--report-file','reports/lab2/lcov.info'], { encoding:'utf8' });
process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
fs.writeFileSync('reports/lab2/coverage.txt', (run.stdout || '') + (run.stderr || ''));
if(run.status !== 0) process.exit(run.status || 1);
const rows = fs.readFileSync('reports/lab2/lcov.info','utf8').split('end_of_record').filter(x=>/^SF:contracts\//m.test(x));
const totals={ linesFound:0,linesHit:0,branchesFound:0,branchesHit:0 };
const contracts=rows.map(row=>{
  const get=key=>Number(row.match(new RegExp(`^${key}:(\\d+)`,'m'))?.[1] || 0);
  const value={file:row.match(/^SF:(.+)/m)[1],linesFound:get('LF'),linesHit:get('LH'),branchesFound:get('BRF'),branchesHit:get('BRH')};
  for(const key of Object.keys(totals))totals[key]+=value[key];return value;
});
const summary={generatedAt:new Date().toISOString(),tool:'forge coverage --ir-minimum',contracts,...totals,
  lines:100*totals.linesHit/totals.linesFound,branches:100*totals.branchesHit/totals.branchesFound};
fs.writeFileSync('reports/lab2/coverage.json',JSON.stringify(summary,null,2)+'\n');
console.log('Own Solidity contracts:',summary.lines.toFixed(2)+'% lines,',summary.branches.toFixed(2)+'% branches');
if(!rows.length || summary.lines<85 || summary.branches<85)throw Error('Solidity line/branch coverage must reach 85%');
