from __future__ import annotations

import math

from backend.app.core.config import Settings
from backend.app.core.contracts import PhysicsResult, TwinState


def _angular_difference_deg(a: float, b: float) -> float:
    delta = abs((a - b) % 360.0)
    return min(delta, 360.0 - delta)


def estimate_power(
    state: TwinState,
    settings: Settings,
    *,
    panel_tilt_deg: float | None = None,
    panel_azimuth_deg: float | None = None,
) -> PhysicsResult:
    """
    Simple hackathon baseline.

    Convention:
    - panel tilt 0 deg: panel surface horizontal;
    - panel tilt 90 deg: panel surface vertical;
    - panel normal elevation = 90 - tilt.
    """
    tilt = state.panel.tilt_deg if panel_tilt_deg is None else float(panel_tilt_deg)
    azimuth = state.panel.azimuth_deg if panel_azimuth_deg is None else float(panel_azimuth_deg) % 360.0

    if state.sun.elevation_deg <= 0.0:
        return PhysicsResult(
            expected_power_w=0.0,
            incidence_angle_deg=90.0,
            effective_illumination=0.0,
        )

    normal_elevation_deg = 90.0 - tilt
    sun_el = math.radians(state.sun.elevation_deg)
    normal_el = math.radians(normal_elevation_deg)
    az_delta = math.radians(_angular_difference_deg(state.sun.azimuth_deg, azimuth))

    cos_incidence = (
        math.sin(sun_el) * math.sin(normal_el)
        + math.cos(sun_el) * math.cos(normal_el) * math.cos(az_delta)
    )
    cos_incidence = max(-1.0, min(1.0, cos_incidence))

    incidence_angle_deg = math.degrees(math.acos(cos_incidence))
    alignment = max(0.0, cos_incidence)

    effective_illumination = (
        state.environment.illumination
        * (1.0 - state.environment.shadow_probability)
        * state.environment.dust_factor
    )
    effective_illumination = max(0.0, min(1.0, effective_illumination))
    power = settings.panel_max_power_w * alignment * effective_illumination

    return PhysicsResult(
        expected_power_w=round(max(0.0, power), 4),
        incidence_angle_deg=round(incidence_angle_deg, 4),
        effective_illumination=round(effective_illumination, 6),
    )
