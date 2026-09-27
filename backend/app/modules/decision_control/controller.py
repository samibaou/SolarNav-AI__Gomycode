from __future__ import annotations

from backend.app.core.contracts import Decision, OptimizationResult, TwinState
from backend.app.modules.data_twin.digital_twin import DigitalTwin


def apply_decision(twin: DigitalTwin, decision: Decision, optimization: OptimizationResult) -> TwinState:
    """Apply only the optimizer-approved target; reject arbitrary LLM angles."""
    if decision.action == "HOLD":
        return twin.state

    best = optimization.best
    if (
        abs(decision.target_tilt_deg - best.tilt_deg) > 1e-9
        or abs(decision.target_azimuth_deg - best.azimuth_deg) > 1e-9
    ):
        raise ValueError("Controller rejected target not produced by optimizer")

    return twin.move_panel(tilt_deg=best.tilt_deg, azimuth_deg=best.azimuth_deg)
