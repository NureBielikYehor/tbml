from __future__ import annotations
import numpy as np
import pandas as pd
from pathlib import Path

NUMERIC = ["goal_log", "duration_days", "launch_month", "launch_weekday"]
CATEGORICAL = ["category", "main_category", "country", "currency"]
FEATURES = NUMERIC + CATEGORICAL + ["description"]
FORBIDDEN = {"pledged", "usd pledged", "usd_pledged_real", "backers", "state", "usd_goal_real"}


def load_campaigns(path, descriptions=None):
    raw = pd.read_csv(path, dtype={"ID": "string"})
    data = raw[raw["state"].isin(["successful", "failed"])].copy()
    data["launched"] = pd.to_datetime(data["launched"], utc=True, errors="coerce")
    data["deadline"] = pd.to_datetime(data["deadline"], utc=True, errors="coerce")
    data["goal"] = pd.to_numeric(data["goal"], errors="coerce")
    valid = (data["goal"].gt(0) & np.isfinite(data["goal"]) & data["launched"].notna() &
             data["deadline"].notna() & data["deadline"].gt(data["launched"]))
    data = data[valid].drop_duplicates("ID").sort_values(["launched", "ID"]).reset_index(drop=True)
    data["description"] = ""
    text_info = {"source": None, "matched_nonempty_descriptions": 0,
                 "availability_at_launch": "not_verified", "title_used_as_description": False}
    if descriptions is not None:
        columns = pd.read_csv(descriptions, nrows=0).columns.tolist()
        ids = next((c for c in ["ID", "id", "project_id"] if c in columns), None)
        text = next((c for c in ["blurb", "description", "desc", "summary", "story"] if c in columns), None)
        if ids is None or text is None:
            raise ValueError(f"No explicit ID/description fields in enriched source: {columns}")
        extra = pd.read_csv(descriptions, usecols=[ids, text], dtype={ids: "string", text: "string"})
        extra = extra.dropna(subset=[ids]).drop_duplicates(ids)
        lookup = extra.set_index(ids)[text].fillna("")
        data["description"] = data["ID"].map(lookup).fillna("").astype(str)
        text_info.update(source=Path(descriptions).name, column=text,
                         matched_nonempty_descriptions=int(data["description"].str.strip().ne("").sum()))
    info = {"raw_rows": len(raw), "clean_rows": len(data),
            "excluded_rows": len(raw) - len(data), "text": text_info}
    return data, info


def training_features(data):
    frame = pd.DataFrame(index=data.index)
    frame["goal_log"] = np.log1p(data["goal"].astype(float))
    frame["duration_days"] = (data["deadline"] - data["launched"]).dt.total_seconds() / 86400
    frame["launch_month"] = data["launched"].dt.month.astype(float)
    frame["launch_weekday"] = data["launched"].dt.weekday.astype(float)
    for column in CATEGORICAL:
        frame[column] = data[column].fillna("Unknown").astype(str)
    frame["description"] = data["description"].fillna("").astype(str)
    assert not FORBIDDEN.intersection(frame.columns)
    return frame[FEATURES]


def inference_features(values):
    goal = float(values["goal"])
    duration = float(values["duration_days"])
    if not np.isfinite(goal) or not 0 < goal <= 1e12 or not np.isfinite(duration) or not 0 < duration <= 90:
        raise ValueError("Invalid goal or duration")
    launch = pd.Timestamp(values["launch_at"])
    if pd.isna(launch):
        raise ValueError("Missing launch date")
    return pd.DataFrame([{
        "goal_log": np.log1p(goal), "duration_days": duration,
        "launch_month": float(launch.month), "launch_weekday": float(launch.weekday()),
        **{key: str(values.get(key) or "Unknown") for key in CATEGORICAL},
        "description": str(values.get("description") or ""),
    }])[FEATURES]


def temporal_split(data):
    validation_start = data.iloc[int(len(data) * 0.70)]["launched"].floor("D")
    test_start = data.iloc[int(len(data) * 0.85)]["launched"].floor("D")
    train = data[(data.launched < validation_start) & (data.deadline < validation_start)]
    validation = data[(data.launched >= validation_start) & (data.launched < test_start) & (data.deadline < test_start)]
    test = data[data.launched >= test_start]
    if min(len(train), len(validation), len(test)) == 0:
        raise ValueError("Insufficient data for disjoint chronological splits")
    return {"train": train, "validation": validation, "test": test}, {
        "validation_start": validation_start.isoformat(), "test_start": test_start.isoformat(),
        "gap_policy": "Training/validation campaign deadlines must precede the next split's launch boundary",
        "purged_boundary_rows": len(data) - len(train) - len(validation) - len(test),
    }
