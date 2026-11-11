"""Ablations, inference timing, paired bootstrap, and plots on the fixed held-out split."""
from __future__ import annotations
import json
import platform
import time
from pathlib import Path
import joblib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, roc_curve, precision_recall_curve
from sklearn.pipeline import Pipeline
from ml.features import load_campaigns, temporal_split, training_features
from ml.train import models, metrics

ROOT = Path(__file__).resolve().parents[1]


def main():
    data, _ = load_campaigns(ROOT/"data/raw/ks-projects-201801.csv", ROOT/"data/raw/descriptions.csv")
    data = data[data.description.str.strip().ne("")].reset_index(drop=True)
    parts, _ = temporal_split(data)
    X = {k: training_features(v) for k,v in parts.items()}
    y = {k: v.state.eq("successful").astype(int).to_numpy() for k,v in parts.items()}
    bundle = joblib.load(ROOT/"models/bundle.joblib")
    evaluation = {}
    alternatives = {
        "numeric_only_logistic": (models(False)["logistic_regression"], X),
        "description_only_logistic": (Pipeline([("tfidf", TfidfVectorizer(max_features=8000,min_df=3,ngram_range=(1,2),sublinear_tf=True)),
          ("classifier", LogisticRegression(C=1,max_iter=600,solver="saga",random_state=42,tol=1e-3))]), {k:v.description for k,v in X.items()}),
    }
    for name,(model,features) in alternatives.items():
        model.fit(features["train"],y["train"])
        p=model.predict_proba(features["validation"])[:,1]
        threshold=max(np.linspace(.1,.9,81),key=lambda t:f1_score(y["validation"],p>=t))
        evaluation[name]=metrics(y["test"],model.predict_proba(features["test"])[:,1],threshold)
        print(name,evaluation[name],flush=True)
    manifest=json.loads((ROOT/"reports/ml/metrics.json").read_text())
    selected=bundle["selected"]
    evaluation["text_and_numeric_logistic"]=manifest["evaluation"]["logistic_regression"]["test"]
    stored=pd.read_csv(ROOT/"data/processed/test-predictions.csv")
    a=stored[selected].to_numpy()>=bundle["thresholds"][selected]
    b=stored.baseline.to_numpy()>=bundle["thresholds"]["baseline"]
    target=stored.target.to_numpy(dtype=bool)
    def fast_f1(truth,prediction):
        tp=np.sum(truth & prediction); return 2*tp/max(1,np.sum(truth)+np.sum(prediction))
    rng=np.random.default_rng(42)
    gains=[]
    for _ in range(1000):
        indices=rng.integers(0,len(target),size=len(target))
        gains.append(fast_f1(target[indices],a[indices])-fast_f1(target[indices],b[indices]))
    sample=X["test"].iloc[[0]]
    model=bundle["models"][selected]
    model.predict_proba(sample)
    latencies=[]
    for _ in range(50):
        start=time.perf_counter();model.predict_proba(sample);latencies.append((time.perf_counter()-start)*1000)
    report={"ablations":evaluation,"paired_bootstrap_f1_gain_95_percent_interval":np.quantile(gains,[.025,.975]).tolist(),
      "bootstrap_samples":1000,"inference_50_warm_calls_ms":{"median":float(np.median(latencies)),"p95":float(np.quantile(latencies,.95))},
      "hardware":platform.platform(),"limitations":["Bootstrap assumes independent test cases; it does not measure cross-platform or temporal deployment uncertainty.",
       "Warm inference excludes process startup, HTTP, and chain confirmation.","Ablations use the same cohort and chronological splits as the main experiment; they do not alter the selected production model."]}
    (ROOT/"reports/ml/experiments.json").write_text(json.dumps(report,indent=2)+"\n")
    out=ROOT/"reports/figures"
    for kind in ["roc","pr","calibration"]:
        plt.figure(figsize=(8,5))
        for name in ["baseline","logistic_regression","gradient_boosting"]:
            p=stored[name]
            if kind=="roc":
                x,z,_=roc_curve(target,p);plt.plot(x,z,label=name)
            elif kind=="pr":
                precision,recall,_=precision_recall_curve(target,p);plt.plot(recall,precision,label=name)
            else:
                fraction,mean=calibration_curve(target,p,n_bins=10);plt.plot(mean,fraction,marker="o",label=name)
        if kind in ["roc","calibration"]:plt.plot([0,1],[0,1],"--",color="gray",linewidth=.8)
        labels={"roc":("False positive rate","True positive rate"),"pr":("Recall","Precision"),"calibration":("Прогнозована ймовірність","Фактична частка успіху")}
        plt.xlabel(labels[kind][0]);plt.ylabel(labels[kind][1]);plt.legend();plt.tight_layout();plt.savefig(out/f"ml-{kind}.png",dpi=150);plt.close()
    plt.figure(figsize=(8,5));plt.bar(["Лише числа", "Лише опис", "Числа + опис"],[v["f1"] for v in evaluation.values()],color=["#b68648","#819170","#335c48"])
    plt.ylabel("F1 на однаковій відкладеній вибірці");plt.ylim(0,1);plt.tight_layout();plt.savefig(out/"ml-ablation.png",dpi=150);plt.close()
    print(json.dumps(report,indent=2),flush=True)


if __name__=="__main__":main()
