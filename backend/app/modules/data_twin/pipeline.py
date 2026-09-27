from backend.app.core.contracts import (
    BatteryState,
    EnergyState,
    EnvironmentState,
    PanelState,
    RawInput,
    SunState,
    TwinState,
)


def normalize_azimuth(value: float) -> float:
    return value % 360.0


def build_twin_state(raw: RawInput) -> TwinState:
    """Convert validated raw input into the canonical Digital Twin state."""
    return TwinState(
        timestamp=raw.timestamp,
        sun=SunState(
            azimuth_deg=normalize_azimuth(raw.sun_azimuth_deg),
            elevation_deg=raw.sun_elevation_deg,
        ),
        panel=PanelState(
            tilt_deg=raw.panel_tilt_deg,
            azimuth_deg=normalize_azimuth(raw.panel_azimuth_deg),
        ),
        battery=BatteryState(soc_pct=raw.battery_soc_pct),
        environment=EnvironmentState(
            illumination=raw.illumination,
            shadow_probability=raw.shadow_probability,
            dust_factor=raw.dust_factor,
        ),
        energy=EnergyState(observed_power_w=raw.observed_power_w),
    )
