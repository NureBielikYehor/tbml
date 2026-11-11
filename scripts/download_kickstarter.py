"""Download the recommended public Kickstarter CSV and preserve source metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATASET = "kemical/kickstarter-projects"
FILENAME = "ks-projects-201801.csv"
BASE = "https://www.kaggle.com/api/v1/datasets"
DOWNLOAD_URL = f"{BASE}/download/{DATASET}/{FILENAME}"


def fetch_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": "tbml-data-audit/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Replace an existing local CSV")
    args = parser.parse_args()
    output = ROOT / "data/raw"
    output.mkdir(parents=True, exist_ok=True)
    destination = output / FILENAME
    if destination.exists() and not args.force:
        raise SystemExit(f"Already exists: {destination}. Reuse it or explicitly pass --force.")

    cards = fetch_json(f"{BASE}/list?search=kickstarter-projects")
    card = next((item for item in cards if item.get("ref") == DATASET), None)
    if card is None:
        raise SystemExit("The expected dataset card was not returned; no file was downloaded.")
    listing = fetch_json(f"{BASE}/list/{DATASET}")
    files = listing.get("datasetFiles", [])
    file_info = next((item for item in files if item.get("name") == FILENAME), None)
    if file_info is None:
        raise SystemExit("The expected CSV is absent from the public file listing.")

    # Download into temporary files; do not replace a previous CSV on a failed request.
    request = urllib.request.Request(DOWNLOAD_URL, headers={"User-Agent": "tbml-data-audit/1.0"})
    with tempfile.TemporaryDirectory(prefix="kickstarter-", dir=output) as temporary:
        downloaded = Path(temporary) / "download"
        extracted = Path(temporary) / FILENAME
        with urllib.request.urlopen(request, timeout=90) as response, downloaded.open("wb") as target:
            shutil.copyfileobj(response, target)
        if zipfile.is_zipfile(downloaded):
            with zipfile.ZipFile(downloaded) as archive:
                names = [name for name in archive.namelist() if Path(name).name == FILENAME]
                if len(names) != 1:
                    raise SystemExit("The download does not contain exactly one expected CSV.")
                with archive.open(names[0]) as source, extracted.open("wb") as target:
                    shutil.copyfileobj(source, target)
        else:
            downloaded.replace(extracted)
        with extracted.open("r", encoding="utf-8-sig") as source:
            header = source.readline().strip()
        if not header.startswith("ID,name,category,"):
            raise SystemExit("Unexpected content/schema; refusing to save it as the recommended CSV.")
        digest = hashlib.sha256()
        with extracted.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        metadata = {
            "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
            "dataset": DATASET, "page_url": f"https://www.kaggle.com/datasets/{DATASET}",
            "download_url": DOWNLOAD_URL, "filename": FILENAME,
            "sha256": digest.hexdigest(), "bytes": extracted.stat().st_size,
            "card": {key: card.get(key) for key in
                     ("ref", "title", "subtitle", "creatorName", "licenseName", "lastUpdated", "currentVersionNumber")},
            "file_metadata": file_info,
        }
        extracted.replace(destination)
        (output / "kickstarter-source.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Downloaded {FILENAME}: {metadata['bytes']} bytes, sha256={metadata['sha256']}")
    print(f"License reported by Kaggle: {metadata['card']['licenseName']}")


if __name__ == "__main__":
    main()
