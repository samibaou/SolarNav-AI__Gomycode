import pytest

from backend.app.modules.decision_control.optimizer import angular_distance_deg, optimize


@pytest.mark.parametrize("a,b,expected", [(350,10,20),(10,350,20),(0,180,180),(45,45,0)])
def test_angular_distance_wraparound(a,b,expected):
    assert angular_distance_deg(a,b) == pytest.approx(expected)


def test_optimizer_uses_energy_units_and_valid_angles(twin_state, test_settings):
    result = optimize(twin_state, test_settings)
    assert result.horizon_minutes == test_settings.optimization_horizon_min
    assert 0 <= result.best.tilt_deg <= 90
    assert 0 <= result.best.azimuth_deg < 360
    assert result.best.solar_energy_wh >= 0
    assert result.best.motor_cost_wh >= 0
    assert result.net_gain_wh >= -1e-9
    assert result.best.net_energy_wh >= result.current.net_energy_wh - 1e-9


def test_optimizer_does_not_move_when_sun_below_horizon(twin_state, test_settings):
    state = twin_state.model_copy(update={"sun": twin_state.sun.model_copy(update={"elevation_deg": -3.0})})
    result = optimize(state, test_settings)
    assert result.best.tilt_deg == state.panel.tilt_deg
    assert result.best.azimuth_deg == state.panel.azimuth_deg
    assert result.net_gain_wh == pytest.approx(0.0)
