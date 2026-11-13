"""Run Slither and attach a disposition to every finding; fail on an unreviewed finding."""
from __future__ import annotations
import json,os,subprocess,sys
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
TIMESTAMP={
 'constructor':'Funding/voting/submission periods are bounded. Timestamp defines deadlines, never randomness. Validators can influence boundary inclusion; minimum voting window is 60 seconds and public demo uses 120 seconds. Boundary tests verify >= semantics.',
 'startFunding':'Starting at or after the immutable funding deadline is rejected. Transaction ordering near the boundary remains a known risk; submit in advance.',
 'contribute':'Contributions at or after the deadline revert. Late transactions cannot reopen funding; no randomness depends on time.',
 'finalizeFunding':'Anyone can finalize after the deadline; earlier calls revert. Censorship/delays remain possible on a public network.',
 'submitReport':'The immutable submission window bounds author inactivity. Pause does not stop the clock; after recovery an expired submission can lead to refunds.',
 'vote':'Votes are accepted strictly before the deadline. Validators/ordering near expiry are residual risks; this is not a source of randomness.',
 'finalizeMilestone':'Finalization requires the voting deadline to have passed. Pause can delay completion, but cannot fabricate votes or release an unapproved tranche.',
 'expireSubmission':'Anyone may trigger refunds after the submission deadline. Conservative expiry prevents indefinite author inactivity.',
 'publishPrediction':'Expiry must be in the future and at most seven days away. A malicious oracle cannot change a funded campaign or withdraw funds.',
 'hasValidPrediction':'Stale predictions are rejected before campaign launch; expiry does not promise that an external ML estimate is correct.',
 'hasVoted':'False positive caused by taint through the milestone struct that also contains voteDeadline. This function only checks index bounds and a bitmap; it does not read block.timestamp.'}
LOW={
 'withdrawPayout':'Intentional ETH call. onlyAuthor, nonReentrant and credit reset before interaction; failed transfers revert the entire transaction and restore the credit. Recipient-failure and reentry tests cover rollback.',
 'claimRefund':'Intentional ETH call. nonReentrant and claimed/remaining/total updated before interaction. A failed recipient cannot block other backers; a revert restores the claim. Tests cover hostile recipients, repeated claims and reentry.'}
def main():
    out=ROOT/'reports/lab2';out.mkdir(parents=True,exist_ok=True)
    raw=out/'slither.json';raw.unlink(missing_ok=True)
    env=os.environ.copy();env['PATH']=str(ROOT/'.tools/bin')+os.pathsep+env['PATH']
    executable=Path(sys.executable).parent/'slither'
    args=[str(executable),'contracts/CampaignFactory.sol','--compile-force-framework','solc','--solc','.tools/bin/solc',
          '--solc-remaps','@openzeppelin/=node_modules/@openzeppelin/','--solc-args','--optimize --optimize-runs 200 --via-ir --evm-version cancun',
          '--filter-paths','node_modules','--json',str(raw),'--json-types','detectors','--fail-high']
    result=subprocess.run(args,cwd=ROOT,env=env,text=True,capture_output=True)
    (out/'slither.txt').write_text(result.stdout+result.stderr)
    if not raw.exists(): print(result.stderr);raise SystemExit(result.returncode or 1)
    data=json.loads(raw.read_text())
    if not data.get('success'): raise SystemExit('Slither analysis failed')
    findings=[]
    for item in data.get('results',{}).get('detectors',[]):
        function=next((e['name'] for e in item['elements'] if e['type']=='function'),None)
        note=TIMESTAMP.get(function) if item['check']=='timestamp' else LOW.get(function) if item['check']=='low-level-calls' else None
        reviewed=note is not None and item['impact'] in ('Low','Informational')
        findings.append({'id':item['id'],'detector':item['check'],'impact':item['impact'],'function':function,
                         'description':item['description'],'reviewed':reviewed,'disposition':note or 'New finding: manual review required'})
    report={'executedAt':datetime.now(timezone.utc).isoformat(),'tool':'Slither','findings':findings,
            'unreviewed':sum(not x['reviewed'] for x in findings)}
    (out/'security-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(f"Slither: {len(findings)} findings; {report['unreviewed']} unreviewed. Full output: reports/lab2/slither.txt")
    for finding in findings: print(f"{finding['impact']}: {finding['detector']} / {finding['function']} — {'reviewed' if finding['reviewed'] else 'REQUIRES REVIEW'}")
    if report['unreviewed'] or result.returncode: raise SystemExit(1)
if __name__=='__main__': main()
