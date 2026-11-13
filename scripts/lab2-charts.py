"""Create gas/optimization charts and a dated ETH/USD scenario cost calculation."""
import json,os,urllib.request
from pathlib import Path
from datetime import datetime,timezone
from decimal import Decimal
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'reports/lab2'
def main():
    gas=json.loads((OUT/'gas.json').read_text());opt=json.loads((OUT/'optimizations.json').read_text())
    entries={}
    for row in gas['rows']: entries[row['function']]=max(entries.get(row['function'],0),row['gasUsed'])
    labels=list(entries);values=list(entries.values())
    fig,ax=plt.subplots(figsize=(19,9));ax.bar(range(len(values)),values,color='#196b75');ax.set_xticks(range(len(labels)),labels,rotation=75,ha='right',fontsize=9)
    ax.set_ylabel('Gas used');ax.set_title('Measured gas: deployments and state-changing functions (maximum per observed variant)');ax.grid(axis='y',alpha=.2);fig.tight_layout();fig.savefig(OUT/'gas-by-function.png',dpi=160);plt.close(fig)
    fig,ax=plt.subplots(figsize=(10,5));cases=opt['cases'];bars=ax.bar([c['name'] for c in cases],[c['totalGas'] for c in cases],color=['#8c8c8c','#3f8790','#196b75']);ax.bar_label(bars,padding=3);ax.set_ylabel('Scenario gas');ax.set_title('Two sequential code optimizations; identical EVM snapshot');fig.tight_layout();fig.savefig(OUT/'gas-optimizations.png',dpi=160);plt.close(fig)
    source='https://api.coinbase.com/v2/prices/ETH-USD/spot'
    if os.getenv('ETH_USD'):
        price=Decimal(os.environ['ETH_USD']);quote={'source':'Explicit ETH_USD assumption (not a fetched market quote)','amount':str(price)}
    else:
        request=urllib.request.Request(source,headers={'User-Agent':'StepFund-lab2'})
        with urllib.request.urlopen(request,timeout=30) as response:
            data=json.load(response);server_date=response.headers.get('Date')
        price=Decimal(data['data']['amount']);quote={'source':source,'amount':str(price),'currency':'USD','responseDate':server_date,'retrievedAt':datetime.now(timezone.utc).isoformat()}
    if not price.is_finite() or price<=0:raise ValueError('ETH/USD must be finite and positive')
    scenarios=[]
    for item in gas['scenario']['prices']:
        eth=Decimal(item['gas'])*Decimal(str(item['gasGwei']))/Decimal(10**9)
        scenarios.append({'gasGwei':item['gasGwei'],'gas':item['gas'],'eth':str(eth),'usd':str(eth*price)})
    report={'generatedAt':datetime.now(timezone.utc).isoformat(),'quote':quote,'scenario':scenarios,'note':'5 and 50 gwei are explicit ordinary/elevated scenarios, not measurements of the current network median. Public-testnet ETH has no sale price; USD is an illustrative Ethereum fee calculation using ETH/USD.'}
    (OUT/'scenario-cost.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2));print('Charts saved in reports/lab2')
if __name__=='__main__':main()
