from backend.app.core.contracts import EnergyState, PhysicsResult
from backend.app.modules.intelligence.diagnostic import diagnose


def test_no_observed_data_returns_no_data(twin_state):
    state = twin_state.model_copy(update={"energy": EnergyState(observed_power_w=None)})
    result = diagnose(state, PhysicsResult(expected_power_w=800, incidence_angle_deg=5, effective_illumination=.8))
    assert result.status == "NO_DATA"


def test_large_underperformance_is_anomaly(twin_state):
    state = twin_state.model_copy(update={"energy": EnergyState(observed_power_w=400)})
    result = diagnose(state, PhysicsResult(expected_power_w=800, incidence_angle_deg=5, effective_illumination=.8))
    assert result.status == "ANOMALY"
    assert result.performance_gap_pct == 50


def test_small_gap_is_ok(twin_state):
    state = twin_state.model_copy(update={"energy": EnergyState(observed_power_w=720)})
    result = diagnose(state, PhysicsResult(expected_power_w=800, incidence_angle_deg=5, effective_illumination=.8))
    assert result.status == "OK"
