"""Entraîne le modèle d'angle optimal et le sauvegarde dans models/angle_model.joblib."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.modules.intelligence.angle_training import save_model, train_model

save_model(train_model())
