"""Extract real short campaign descriptions by ID from the original Web Robots snapshot."""
from __future__ import annotations
import csv
import gzip
import hashlib
import json
import shutil
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
URL = "https://s3.amazonaws.com/weruns/forfun/Kickstarter/Kickstarter_2018-01-12T10_20_09_196Z.json.gz"


def main():
    folder = ROOT / "data/raw"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "descriptions.csv"
    if target.exists():
        raise SystemExit(f"Already exists: {target}; no download needed.")
    with tempfile.TemporaryDirectory(dir=folder, prefix="webrobots-") as tmp:
        archive = Path(tmp) / "snapshot.json.gz"
        with urllib.request.urlopen(URL, timeout=120) as response, archive.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        with archive.open("rb") as stream:
            archive_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        partial = Path(tmp) / "descriptions.csv"
        ids = set(); rows = 0; nonempty = 0
        with gzip.open(archive, "rt", encoding="utf-8") as source, partial.open("w", newline="", encoding="utf-8") as output:
            writer = csv.DictWriter(output, fieldnames=["ID", "blurb", "snapshot_captured_at", "launched_at"])
            writer.writeheader()
            for line in source:
                record = json.loads(line)
                value = record.get("data", {})
                identifier = str(value.get("id", ""))
                if not identifier or identifier in ids:
                    continue
                ids.add(identifier); rows += 1
                blurb = str(value.get("blurb") or "").strip()
                nonempty += bool(blurb)
                writer.writerow({"ID": identifier, "blurb": blurb,
                    "snapshot_captured_at": record.get("created_at"), "launched_at": value.get("launched_at")})
        partial.replace(target)
    with target.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    info = {"provider": "Web Robots", "page_url": "https://webrobots.io/kickstarter-datasets/",
        "download_url": URL, "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
        "archive_sha256": archive_hash, "extracted_csv_sha256": digest,
        "unique_campaigns": rows, "nonempty_blurbs": nonempty,
        "license": "No explicit dataset reuse license found on provider page; raw texts are not redistributed in Git.",
        "text_type": "Short campaign description (blurb), not full story and not title",
        "availability_at_launch": "Not verified: snapshot was collected after many campaigns ended",
        "deduplication": "First occurrence of campaign ID within the fixed snapshot"}
    (folder / "descriptions-source.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
    report = ROOT / "reports/data/description-source.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(info, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
