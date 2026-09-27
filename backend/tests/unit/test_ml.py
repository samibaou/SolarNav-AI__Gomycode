from backend.app.modules.intelligence.ml import PowerPredictor


def test_ml_fallback_is_available_without_model(twin_state, test_settings):
    result = PowerPredictor(test_settings).predict(twin_state)
    assert result.predicted_power_w >= 0
    assert result.model_name == "physics-fallback"
    assert 0 <= result.confidence <= 1
