import pytest

from backend.app.core.contracts import Decision
from backend.app.modules.data_twin.digital_twin import DigitalTwin
from backend.app.modules.decision_control.controller import apply_decision
from backend.app.modules.decision_control.optimizer import optimize


def test_hold_does_not_move(twin_state, test_settings):
    optimization = optimize(twin_state, test_settings)
    decision = Decision(action="HOLD", target_tilt_deg=twin_state.panel.tilt_deg, target_azimuth_deg=twin_state.panel.azimuth_deg, reason="test", explanation_source="template")
    assert apply_decision(DigitalTwin(twin_state), decision, optimization).panel == twin_state.panel


def test_controller_rejects_target_not_from_optimizer(twin_state, test_settings):
    optimization = optimize(twin_state, test_settings)
    wrong_tilt = 0.0 if optimization.best.tilt_deg != 0 else 5.0
    decision = Decision(action="MOVE", target_tilt_deg=wrong_tilt, target_azimuth_deg=optimization.best.azimuth_deg, reason="bad", explanation_source="template")
    with pytest.raises(ValueError):
        apply_decision(DigitalTwin(twin_state), decision, optimization)


def test_controller_applies_optimizer_target(twin_state, test_settings):
    optimization = optimize(twin_state, test_settings)
    decision = Decision(
        action="MOVE",
        target_tilt_deg=optimization.best.tilt_deg,
        target_azimuth_deg=optimization.best.azimuth_deg,
        reason="approved",
        explanation_source="template",
    )
    after = apply_decision(DigitalTwin(twin_state), decision, optimization)
    assert after.panel.tilt_deg == optimization.best.tilt_deg
    assert after.panel.azimuth_deg == optimization.best.azimuth_deg
