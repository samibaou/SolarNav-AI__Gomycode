from __future__ import annotations

from backend.app.core.config import Settings
from backend.app.core.contracts import CandidateAction, OptimizationResult, TwinState
from backend.app.modules.intelligence.physics import estimate_power


TILT_STEP_DEG = 5
AZIMUTH_STEP_DEG = 10


def angular_distance_deg(a: float, b: float) -> float:
    delta = abs((a - b) % 360.0)
    return min(delta, 360.0 - delta)


def _candidate(
    state: TwinState,
    settings: Settings,
    *,
    tilt_deg: float,
    azimuth_deg: float,
    movement_cost: bool,
) -> CandidateAction:
    physics = estimate_power(
        state,
        settings,
        panel_tilt_deg=tilt_deg,
        panel_azimuth_deg=azimuth_deg,
    )
    horizon_h = settings.optimization_horizon_min / 60.0
    solar_energy_wh = physics.expected_power_w * horizon_h

    movement_deg = 0.0
    if movement_cost:
        movement_deg = (
            abs(tilt_deg - state.panel.tilt_deg)
            + angular_distance_deg(azimuth_deg, state.panel.azimuth_deg)
        )
    motor_cost_wh = movement_deg * settings.motor_cost_wh_per_deg
    net_energy_wh = solar_energy_wh - motor_cost_wh

    return CandidateAction(
        tilt_deg=round(tilt_deg, 4),
        azimuth_deg=round(azimuth_deg % 360.0, 4),
        predicted_power_w=round(physics.expected_power_w, 4),
        solar_energy_wh=round(solar_energy_wh, 4),
        motor_cost_wh=round(motor_cost_wh, 4),
        net_energy_wh=round(net_energy_wh, 4),
    )


def optimize(state: TwinState, settings: Settings) -> OptimizationResult:
    """Compare orientations in Wh, never by subtracting Wh from W."""
    current = _candidate(
        state,
        settings,
        tilt_deg=state.panel.tilt_deg,
        azimuth_deg=state.panel.azimuth_deg,
        movement_cost=False,
    )
    best = current

    for tilt in range(0, 91, TILT_STEP_DEG):
        for azimuth in range(0, 360, AZIMUTH_STEP_DEG):
            candidate = _candidate(
                state,
                settings,
                tilt_deg=float(tilt),
                azimuth_deg=float(azimuth),
                movement_cost=True,
            )
            if candidate.net_energy_wh > best.net_energy_wh:
                best = candidate

    return OptimizationResult(
        horizon_minutes=settings.optimization_horizon_min,
        current=current,
        best=best,
        net_gain_wh=round(best.net_energy_wh - current.net_energy_wh, 4),
    )
