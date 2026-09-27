"""Génère data/processed/angle_training_data.csv (~1 min)."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.modules.intelligence.angle_dataset import DATASET_PATH, generate_dataset

df = generate_dataset()
DATASET_PATH.parent.mkdir(parents=True, exist_ok=True)
df.to_csv(DATASET_PATH, index=False)
print(f"{len(df)} lignes écrites dans {DATASET_PATH}")
print(df.head())
