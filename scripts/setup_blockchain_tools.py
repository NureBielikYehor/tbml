"""Install pinned Linux x86_64 Foundry and solc binaries with upstream checksum verification."""
from __future__ import annotations
import hashlib,io,json,os,platform,tarfile,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
FOUNDRY='v1.9.0'
SOLC='0.8.38'
def fetch(url):
    request=urllib.request.Request(url,headers={'User-Agent':'StepFund-build'})
    return urllib.request.urlopen(request,timeout=120).read()
def main():
    if platform.system()!='Linux' or platform.machine() not in ('x86_64','AMD64'):
        raise SystemExit('This installer targets Linux x86_64. Install Foundry and solc 0.8.38 in .tools/bin manually on other platforms.')
    target=ROOT/'.tools/bin';target.mkdir(parents=True,exist_ok=True)
    release=json.loads(fetch(f'https://api.github.com/repos/foundry-rs/foundry/releases/tags/{FOUNDRY}'))
    asset=next(x for x in release['assets'] if x['name'].endswith('linux_amd64.tar.gz'))
    archive=fetch(asset['browser_download_url']);digest=hashlib.sha256(archive).hexdigest()
    expected=asset.get('digest','').removeprefix('sha256:')
    if not expected or digest!=expected: raise SystemExit('Foundry release checksum mismatch or missing digest')
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as bundle:
        for name in ('forge','cast','anvil'):
            item=bundle.extractfile(name)
            if item is None: raise SystemExit('Missing binary '+name)
            destination=target/name;destination.write_bytes(item.read());destination.chmod(0o755)
    base='https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/'
    index=json.loads(fetch(base+'list.json'));filename=index['releases'][SOLC]
    entry=next(x for x in index['builds'] if x['path']==filename)
    compiler=fetch(base+filename)
    if hashlib.sha256(compiler).hexdigest()!=entry['sha256'].removeprefix('0x'): raise SystemExit('Solc checksum mismatch')
    destination=target/'solc';destination.write_bytes(compiler);destination.chmod(0o755)
    print(f'Installed Foundry {FOUNDRY} and solc {SOLC}; upstream SHA-256 checks passed')
if __name__=='__main__': main()
