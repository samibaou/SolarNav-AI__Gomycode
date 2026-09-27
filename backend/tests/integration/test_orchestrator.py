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


def test_analysis_and_optimization_do_not_mutate_state(twin_state, test_settings):
    store = DigitalTwinStore(twin_state)
    orchestrator = SolarNavOrchestrator(store=store, settings=test_settings)
    before = store.get()
    orchestrator.analyze()
    orchestrator.optimize_current()
    assert store.get() == before
