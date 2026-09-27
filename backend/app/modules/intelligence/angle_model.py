"""Modèle hybride physique + IA : l'IA apprend la correction à apporter à la formule simple.

Angle prédit = formule simple (panneau face au soleil) + correction apprise
(poussière, surchauffe, butée mécanique...). La physique donne la tendance générale
sur tout le ciel, l'IA n'a qu'à apprendre les écarts : plus précis et plus robuste
dans les situations rares qu'un modèle qui apprend tout seul.
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesRegressor

from backend.app.core.config import settings
from backend.app.modules.intelligence.angle_physics import MAX_TILT

MODEL_PATH = settings.root_dir / "models" / "angle_model.joblib"
FEATURES = ["sun_elevation", "sun_azimuth", "is_sunlit", "dust_level", "surface_temp"]
TARGET = "angle_optimal"


def physics_baseline(X: pd.DataFrame) -> np.ndarray:
    """Formule simple : panneau face au soleil (90 - élévation), 0° à l'ombre."""
    facing_sun = np.clip(90.0 - X["sun_elevation"].to_numpy(), 0, MAX_TILT)
    return np.where(X["is_sunlit"].to_numpy() == 1, facing_sun, 0.0)


class PhysicsResidualModel:
    def __init__(self, n_estimators: int = 100, min_samples_leaf: int = 5, random_state: int = 42):
        self.trees = ExtraTreesRegressor(
            n_estimators=n_estimators,
            min_samples_leaf=min_samples_leaf,
            n_jobs=-1,
            random_state=random_state,
        )

    def fit(self, X: pd.DataFrame, y) -> "PhysicsResidualModel":
        self.trees.fit(X, np.asarray(y) - physics_baseline(X))
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return np.clip(physics_baseline(X) + self.trees.predict(X), 0, MAX_TILT)

    def predict_with_uncertainty(self, X: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        """Retourne (angle, incertitude) : l'incertitude est l'écart-type entre les arbres.

        Faible = les arbres sont d'accord (situation bien connue) ;
        élevée = situation rare ou ambiguë, prédiction à prendre avec prudence.
        """
        per_tree = np.stack([tree.predict(X.to_numpy()) for tree in self.trees.estimators_])
        baseline = physics_baseline(X)
        angles = np.clip(baseline + per_tree, 0, MAX_TILT)
        return angles.mean(axis=0), angles.std(axis=0)

    @property
    def feature_importances_(self) -> np.ndarray:
        return self.trees.feature_importances_
