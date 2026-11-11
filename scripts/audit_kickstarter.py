"""Audit the actual recommended CSV; this is not the final Jupyter EDA."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESCRIPTION_COLUMNS = {"description", "desc", "blurb", "summary", "story", "project_description"}
FORBIDDEN_INPUTS = {"pledged", "usd pledged", "usd_pledged_real", "backers", "state"}


def audit(path: Path) -> dict:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    states = Counter()
    missing = Counter()
    identifiers = set()
    duplicates = 0
    row_count = 0
    missing_titles = 0
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        columns = reader.fieldnames or []
        required = {"ID", "name", "category", "state", "goal", "launched", "deadline"}
        if not required.issubset(columns):
            raise ValueError(f"Missing expected columns: {sorted(required - set(columns))}")
        for row in reader:
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f"Malformed CSV record at physical line {reader.line_num}")
            row_count += 1
            states[row["state"]] += 1
            for column in columns:
                if not row[column].strip():
                    missing[column] += 1
            if row["state"] in {"successful", "failed"} and not row["name"].strip():
                missing_titles += 1
            identifier = row["ID"].strip()
            if identifier:
                if identifier in identifiers:
                    duplicates += 1
                identifiers.add(identifier)
    description = [column for column in columns if column.strip().lower() in DESCRIPTION_COLUMNS]
    warnings = []
    if not description:
        warnings.append("No explicit description column found. The name column is a title, not a campaign description.")
    warnings.append("No pre-launch text provenance is established by this CSV audit.")
    warnings.append("This audit is not the required six-chart Jupyter EDA and does not train a model.")
    return {
        "audited_at_utc": datetime.now(timezone.utc).isoformat(),
        "file": path.name, "sha256": digest.hexdigest(), "bytes": path.stat().st_size,
        "rows": row_count, "columns": columns, "states": dict(sorted(states.items())),
        "successful_failed_rows_before_cleaning": states["successful"] + states["failed"],
        "missing_titles_in_successful_failed_rows": missing_titles,
        "missing_by_column": {column: missing[column] for column in columns},
        "unique_nonempty_ids": len(identifiers), "duplicate_nonempty_id_rows": duplicates,
        "explicit_description_columns": description,
        "forbidden_prediction_inputs_present": sorted(FORBIDDEN_INPUTS.intersection(columns)),
        "metadata": {"target": "successful vs failed; policy for other states must be justified",
                     "title_is_description": False, "description_requirement_satisfied": False,
                     "description_status": "missing" if not description else "provenance_not_yet_verified"},
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "data/raw/ks-projects-201801.csv")
    parser.add_argument("--output", type=Path, default=ROOT / "reports/data/kickstarter-audit.json")
    args = parser.parse_args()
    if not args.input.is_file():
        raise SystemExit(f"Dataset not found: {args.input}. Run scripts/download_kickstarter.py first.")
    report = audit(args.input)
    provenance = args.input.parent / "kickstarter-source.json"
    if provenance.is_file():
        source = json.loads(provenance.read_text(encoding="utf-8"))
        if source.get("sha256") == report["sha256"]:
            report["verified_source_metadata"] = {
                key: source.get(key) for key in ("dataset", "page_url", "download_url", "retrieved_at_utc")}
            report["verified_source_metadata"]["license_reported_by_kaggle"] = source.get("card", {}).get("licenseName")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Rows: {report['rows']}; successful/failed: {report['successful_failed_rows_before_cleaning']}")
    print(f"Description columns: {report['explicit_description_columns']}")
    print(f"Saved: {args.output}")


if __name__ == "__main__":
    main()
