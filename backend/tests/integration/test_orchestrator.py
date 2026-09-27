import pytest

from backend.app.modules.data_twin.store import DigitalTwinStore
from backend.app.orchestrator import SolarNavOrchestrator


def test_full_cycle_updates_time_power_and_keeps_soc_bounded(twin_state, test_settings):
    store = DigitalTwinStore(twin_state)
    orchestrator = SolarNavOrchestrator(store=store, settings=test_settings)
    result = orchestrator.run_cycle(step_minutes=5)
    assert result.updated_state.timestamp > result.initial_state.timestamp
    assert result.updated_state.energy.observed_power_w == result.post_move_power_w
    assert 0 <= result.updated_state.battery.soc_pct <= 100
    assert result.decision.action in {"MOVE", "HOLD"}
    assert result.analysis.physics.expected_power_w >= 0
    assert result.analysis.ml.predicted_power_w >= 0
    assert result.analysis.diagnostic.status in {"OK", "ANOMALY", "NO_DATA"}
    assert result.optimization.best.net_energy_wh == pytest.approx(
        result.optimization.best.solar_energy_wh - result.optimization.best.motor_cost_wh
    )
    assert result.optimization.net_gain_wh == pytest.approx(
        result.optimization.best.net_energy_wh - result.optimization.current.net_energy_wh
    )
    if result.decision.action == "MOVE":
        assert result.updated_state.panel.tilt_deg == result.optimization.best.tilt_deg
        assert result.updated_state.panel.azimuth_deg == result.optimization.best.azimuth_deg
    else:
        assert result.updated_state.panel == result.initial_state.panel


def test_analysis_and_optimization_do_not_mutate_state(twin_state, test_settings):
    store = DigitalTwinStore(twin_state)
    orchestrator = SolarNavOrchestrator(store=store, settings=test_settings)
    before = store.get()
    orchestrator.analyze()
    orchestrator.optimize_current()
    assert store.get() == before
