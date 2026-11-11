from __future__ import annotations
import numpy as np


class CategoryBaseline:
    """Category success rates learned exclusively from the training partition."""
    def fit(self, X, y):
        data = X[["category"]].copy()
        data["target"] = np.asarray(y)
        self.global_rate = float(data.target.mean())
        self.rates = data.groupby("category").target.mean().to_dict()
        return self

    def predict_proba(self, X):
        probability = X.category.map(self.rates).fillna(self.global_rate).to_numpy(dtype=float)
        return np.column_stack([1 - probability, probability])
