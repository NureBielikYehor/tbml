import unittest
import numpy as np
import pandas as pd
from ml.baseline import CategoryBaseline
from ml.features import inference_features, temporal_split, training_features, FORBIDDEN


class FeatureSafetyTests(unittest.TestCase):
    def test_baseline_unknown_category_uses_training_global_rate(self):
        baseline = CategoryBaseline().fit(pd.DataFrame({"category": ["A", "A", "B"]}), [1, 0, 0])
        values = baseline.predict_proba(pd.DataFrame({"category": ["A", "B", "new"]}))[:, 1]
        np.testing.assert_allclose(values, [0.5, 0, 1 / 3])

    def test_forbidden_fields_cannot_affect_prediction_features(self):
        data = pd.DataFrame({"goal": [100.0], "launched": pd.to_datetime(["2016-01-01"], utc=True),
            "deadline": pd.to_datetime(["2016-02-01"], utc=True), "category": ["Art"],
            "main_category": ["Art"], "country": ["US"], "currency": ["USD"], "description": ["An art book"]})
        first = training_features(data)
        for field in FORBIDDEN:
            data[field] = 999999
        pd.testing.assert_frame_equal(first, training_features(data))
        self.assertFalse(FORBIDDEN.intersection(first.columns))

    def test_temporal_split_purges_unresolved_outcomes_and_separates_ids(self):
        launch = pd.date_range("2010-01-01", periods=100, freq="10D", tz="UTC")
        data = pd.DataFrame({"ID": range(100), "launched": launch, "deadline": launch + pd.Timedelta(days=30)})
        parts, _ = temporal_split(data)
        self.assertLess(parts["train"].deadline.max(), parts["validation"].launched.min())
        self.assertLess(parts["validation"].deadline.max(), parts["test"].launched.min())
        self.assertFalse(set(parts["train"].ID).intersection(parts["test"].ID))

    def test_inference_rejects_invalid_numbers_and_never_substitutes_title(self):
        request = {"goal": 100, "duration_days": 30, "launch_at": "2026-11-05", "name": "A title"}
        self.assertEqual(inference_features(request).iloc[0].description, "")
        for invalid in [0, -1, float("inf"), float("nan")]:
            with self.assertRaises(ValueError):
                inference_features({**request, "goal": invalid})


if __name__ == "__main__":
    unittest.main()
