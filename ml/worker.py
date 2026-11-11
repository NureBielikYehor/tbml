"""A local line-delimited JSON inference worker; load only artifacts trained in this repo."""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path
import joblib
from ml.features import inference_features

ROOT = Path(__file__).resolve().parents[1]


def main():
    artifact = ROOT / "models/bundle.joblib"
    manifest = json.loads((ROOT / "models/manifest.json").read_text())
    with artifact.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != manifest["model_sha256"]:
        raise ValueError("Model artifact does not match manifest")
    bundle = joblib.load(artifact)
    metadata = {"modelHash": "0x" + digest, "selected": bundle["selected"],
                "usesDescription": bundle["uses_description"], "metrics": manifest["evaluation"],
                "limitations": manifest["limitations"],
                "training": {key: manifest[key] for key in ["dataset_sha256", "description_sha256", "partitions", "environment"]}}
    print(json.dumps({"event": "ready", "metadata": metadata}), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            frame = inference_features(request["features"])
            scores = {name: float(model.predict_proba(frame)[0, 1]) for name, model in bundle["models"].items()}
            print(json.dumps({"id": request["id"], "result": {"scores": scores,
                  "probability": scores[bundle["selected"]], **metadata}}), flush=True)
        except Exception as error:
            print(json.dumps({"id": request.get("id"), "error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
