from __future__ import annotations

from pathlib import Path

from backend.app.core.config import Settings
from backend.app.core.contracts import MLResult, TwinState
from backend.app.modules.intelligence.physics import estimate_power


FEATURE_NAMES = (
    "sun_azimuth_deg",
    "sun_elevation_deg",
    "panel_azimuth_deg",
    "panel_tilt_deg",
    "illumination",
    "shadow_probability",
    "dust_factor",
)


def feature_vector(state: TwinState) -> list[float]:
    return [
        state.sun.azimuth_deg,
        state.sun.elevation_deg,
        state.panel.azimuth_deg,
        state.panel.tilt_deg,
        state.environment.illumination,
        state.environment.shadow_probability,
        state.environment.dust_factor,
    ]


class PowerPredictor:
    """Use a trained model when available, otherwise degrade to the physics baseline."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._model = None
        self._model_name = "physics-fallback"
        self._try_load_model(settings.model_file)

    def _try_load_model(self, path: Path) -> None:
        if not path.exists():
            return
        try:
            import joblib
            self._model = joblib.load(path)
            self._model_name = path.name
        except Exception:
            self._model = None
            self._model_name = "physics-fallback"

    def predict(self, state: TwinState) -> MLResult:
        if self._model is None:
            value = estimate_power(state, self.settings).expected_power_w
            return MLResult(predicted_power_w=value, model_name=self._model_name, confidence=0.60)

        prediction = max(0.0, float(self._model.predict([feature_vector(state)])[0]))
        return MLResult(
            predicted_power_w=round(prediction, 4),
            model_name=self._model_name,
            confidence=0.85,
        )
