from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import csv

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split

from backend.app.core.config import settings

path = settings.root_dir / "data" / "processed" / "training_data.csv"
X, y = [], []
with path.open("r", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    feature_names = [x for x in reader.fieldnames if x != "target_power_w"]
    for row in reader:
        X.append([float(row[name]) for name in feature_names])
        y.append(float(row["target_power_w"]))

X = np.asarray(X); y = np.asarray(y)
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=.2, random_state=42)
model = RandomForestRegressor(n_estimators=150, random_state=42, n_jobs=-1)
model.fit(X_train, y_train)
prediction = model.predict(X_test)
mae = mean_absolute_error(y_test, prediction)
settings.model_file.parent.mkdir(parents=True, exist_ok=True)
joblib.dump(model, settings.model_file)
print(f"Saved: {settings.model_file}")
print(f"Validation MAE: {mae:.3f} W")
