import pytest

from backend.app.modules.intelligence.physics import estimate_power


def test_power_is_zero_when_sun_below_horizon(twin_state, test_settings):
    state = twin_state.model_copy(update={"sun": twin_state.sun.model_copy(update={"elevation_deg": -1.0})})
    assert estimate_power(state, test_settings).expected_power_w == 0.0


def test_power_is_zero_with_full_shadow_probability(twin_state, test_settings):
    env = twin_state.environment.model_copy(update={"shadow_probability": 1.0})
    state = twin_state.model_copy(update={"environment": env})
    assert estimate_power(state, test_settings).expected_power_w == 0.0


def test_power_is_zero_with_zero_dust_factor(twin_state, test_settings):
    env = twin_state.environment.model_copy(update={"dust_factor": 0.0})
    state = twin_state.model_copy(update={"environment": env})
    assert estimate_power(state, test_settings).expected_power_w == 0.0


def test_perfect_alignment_reaches_max(twin_state, test_settings):
    sun = twin_state.sun.model_copy(update={"elevation_deg": 30.0, "azimuth_deg": 120.0})
    env = twin_state.environment.model_copy(update={"illumination": 1.0, "shadow_probability": 0.0, "dust_factor": 1.0})
    panel = twin_state.panel.model_copy(update={"tilt_deg": 60.0, "azimuth_deg": 120.0})
    state = twin_state.model_copy(update={"sun": sun, "environment": env, "panel": panel})
    result = estimate_power(state, test_settings)
    assert result.expected_power_w == pytest.approx(1000.0, abs=.1)
    assert result.incidence_angle_deg == pytest.approx(0.0, abs=.1)
