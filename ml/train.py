from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import platform
import time
from pathlib import Path

import joblib
import numpy as np
from sklearn.compose import ColumnTransformer
from sklearn.decomposition import TruncatedSVD
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, average_precision_score, brier_score_loss,
                             f1_score, log_loss, precision_score, recall_score, roc_auc_score,
                             confusion_matrix)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, StandardScaler

from ml.baseline import CategoryBaseline
from ml.features import CATEGORICAL, NUMERIC, FEATURES, load_campaigns, temporal_split, training_features

ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def models(use_text):
    linear = [
        ("numeric", Pipeline([("impute", SimpleImputer()), ("scale", StandardScaler())]), NUMERIC),
        ("category", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL),
    ]
    trees = [
        ("numeric", SimpleImputer(), NUMERIC),
        ("category", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1), CATEGORICAL),
    ]
    if use_text:
        linear.append(("text", TfidfVectorizer(max_features=8000, min_df=3, ngram_range=(1, 2), sublinear_tf=True), "description"))
        trees.append(("text", Pipeline([
            ("tfidf", TfidfVectorizer(max_features=5000, min_df=3, sublinear_tf=True)),
            ("svd", TruncatedSVD(n_components=24, n_iter=3, random_state=42)),
        ]), "description"))
    return {
        "baseline": CategoryBaseline(),
        "logistic_regression": Pipeline([
            ("features", ColumnTransformer(linear)),
            ("classifier", LogisticRegression(C=1.0, max_iter=600, solver="saga", random_state=42, tol=1e-3)),
        ]),
        "gradient_boosting": Pipeline([
            ("features", ColumnTransformer(trees)),
            ("classifier", HistGradientBoostingClassifier(categorical_features=list(range(4, 8)),
                max_iter=120, max_leaf_nodes=15, l2_regularization=2, random_state=42)),
        ]),
    }


def metrics(y, p, threshold):
    labels = p >= threshold
    return {"accuracy": float(accuracy_score(y, labels)), "precision": float(precision_score(y, labels, zero_division=0)),
        "recall": float(recall_score(y, labels, zero_division=0)), "f1": float(f1_score(y, labels)),
        "roc_auc": float(roc_auc_score(y, p)), "pr_auc": float(average_precision_score(y, p)),
        "brier": float(brier_score_loss(y, p)), "log_loss": float(log_loss(y, p)),
        "threshold": float(threshold), "confusion_matrix": confusion_matrix(y, labels).tolist()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=ROOT / "data/raw/ks-projects-201801.csv")
    parser.add_argument("--descriptions", type=Path, default=ROOT / "data/raw/descriptions.csv")
    parser.add_argument("--numeric-only", action="store_true", help="Explicitly train an incomplete numeric prototype")
    args = parser.parse_args()
    if not args.numeric_only and not args.descriptions.is_file():
        raise FileNotFoundError("Run scripts/download_descriptions.py, or explicitly choose --numeric-only")
    descriptions = args.descriptions if not args.numeric_only else None
    data, audit = load_campaigns(args.data, descriptions)
    if descriptions is not None:
        data = data[data.description.str.strip().ne("")].reset_index(drop=True)
        audit["text_covered_training_cohort"] = len(data)
    parts, split_info = temporal_split(data)
    X = {key: training_features(value) for key, value in parts.items()}
    y = {key: value.state.eq("successful").astype(int).to_numpy() for key, value in parts.items()}
    use_text = X["train"].description.str.strip().ne("").sum() >= 100
    trained = models(use_text)
    evaluation = {}
    predictions = {"id": parts["test"].ID.to_numpy(), "target": y["test"]}
    thresholds = {}
    for name, model in trained.items():
        print(f"Training {name}, text={use_text}...", flush=True)
        started = time.perf_counter()
        model.fit(X["train"], y["train"])
        validation_p = model.predict_proba(X["validation"])[:, 1]
        threshold = max(np.linspace(0.1, 0.9, 81), key=lambda t: f1_score(y["validation"], validation_p >= t))
        thresholds[name] = float(threshold)
        test_p = model.predict_proba(X["test"])[:, 1]
        evaluation[name] = {"fit_and_evaluation_seconds": time.perf_counter() - started,
                            "validation": metrics(y["validation"], validation_p, threshold),
                            "test": metrics(y["test"], test_p, threshold)}
        predictions[name] = test_p
        print(name, json.dumps(evaluation[name]["test"]), flush=True)
    selected = max([name for name in trained if name != "baseline"], key=lambda n: evaluation[n]["validation"]["roc_auc"])
    output = ROOT / "models"
    output.mkdir(exist_ok=True)
    bundle = {"models": trained, "selected": selected, "thresholds": thresholds,
              "uses_description": bool(use_text), "feature_names": FEATURES}
    joblib.dump(bundle, output / "bundle.joblib", compress=3)
    report = {
        "dataset_sha256": sha256(args.data), "description_sha256": sha256(descriptions) if descriptions else None,
        "audit": audit, "split": split_info,
        "partitions": {key: {"rows": len(value), "success_rate": float(value.state.eq("successful").mean()),
                              "launch_min": value.launched.min().isoformat(), "launch_max": value.launched.max().isoformat()}
                       for key, value in parts.items()},
        "evaluation": evaluation, "selected_by_validation_roc_auc": selected,
        "uses_description": bool(use_text), "model_sha256": sha256(output / "bundle.joblib"),
        "environment": {"python": platform.python_version(), **{name: importlib.metadata.version(name)
                        for name in ["numpy", "pandas", "scikit-learn", "joblib"]}},
        "limitations": ["Historical data do not prove descriptions were unchanged at launch.",
                        "Kickstarter funding success is not a prediction of project delivery.",
                        "Deployment on crypto crowdfunding is a domain shift from Kickstarter.",
                        "The text-covered cohort may be affected by snapshot coverage and selection bias."] +
                       ([] if use_text else ["Numeric prototype only: no description source was available."]),
    }
    (output / "manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    reports = ROOT / "reports/ml"
    reports.mkdir(parents=True, exist_ok=True)
    (reports / "metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    import pandas as pd
    processed = ROOT / "data/processed"
    processed.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(predictions).to_csv(processed / "test-predictions.csv", index=False)
    print(f"Selected by validation ROC-AUC: {selected}; SHA256={report['model_sha256']}", flush=True)


if __name__ == "__main__":
    main()
