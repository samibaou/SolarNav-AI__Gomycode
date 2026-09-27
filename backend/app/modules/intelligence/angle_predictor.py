"""Charge le modèle entraîné et prédit l'angle optimal du panneau."""

from functools import lru_cache
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from backend.app.modules.intelligence.angle_dataset import TEMP_RANGE
from backend.app.modules.intelligence.angle_model import FEATURES, MODEL_PATH

# Au-delà de cet écart entre les arbres, la situation est rare ou ambiguë
LOW_CONFIDENCE_DEG = 3.0
# Températures couvertes par l'entraînement (ombre comprise) : au-delà, on borne
TEMP_LIMITS = (-200.0, TEMP_RANGE[1])


@lru_cache(maxsize=1)
def load_model(path: Path = MODEL_PATH):
    """Charge le modèle une seule fois (gardé en mémoire ensuite)."""
    if not Path(path).exists():
        raise FileNotFoundError(f"{path} introuvable : lancer d'abord `python scripts/train_angle_model.py`.")
    return joblib.load(path)


def _build_row(sun_elevation, sun_azimuth, is_sunlit, dust_level, surface_temp) -> pd.DataFrame:
    """Valide les entrées et construit la ligne attendue par le modèle."""
    if not -90 <= sun_elevation <= 90:
        raise ValueError(f"sun_elevation doit être entre -90 et 90° (reçu {sun_elevation})")
    if not 0 <= dust_level <= 100:
        raise ValueError(f"dust_level doit être entre 0 et 100 % (reçu {dust_level})")
    sun_azimuth = sun_azimuth % 360
    surface_temp = float(np.clip(surface_temp, *TEMP_LIMITS))
    return pd.DataFrame(
        [[sun_elevation, sun_azimuth, int(is_sunlit), dust_level, surface_temp]],
        columns=FEATURES,
    )


def predict_optimal_angle(
    sun_elevation: float,
    sun_azimuth: float,
    is_sunlit: bool,
    dust_level: float,
    surface_temp: float,
) -> float:
    """Retourne l'angle optimal prédit (degrés, 0 = à plat, 90 = vertical)."""
    row = _build_row(sun_elevation, sun_azimuth, is_sunlit, dust_level, surface_temp)
    return float(load_model().predict(row)[0])


def predict_with_confidence(
    sun_elevation: float,
    sun_azimuth: float,
    is_sunlit: bool,
    dust_level: float,
    surface_temp: float,
) -> dict:
    """Comme predict_optimal_angle, avec l'incertitude du modèle (pour le dashboard).

    Retourne {"angle": ..., "uncertainty": ± degrés, "confident": bool}.
    """
    row = _build_row(sun_elevation, sun_azimuth, is_sunlit, dust_level, surface_temp)
    angle, uncertainty = load_model().predict_with_uncertainty(row)
    return {
        "angle": float(angle[0]),
        "uncertainty": float(uncertainty[0]),
        "confident": bool(uncertainty[0] < LOW_CONFIDENCE_DEG),
    }

