"""Build RawInput contracts from real sun data instead of the static sample file.

| Field                                 | Source                                          |
|---------------------------------------|-------------------------------------------------|
| sun_azimuth_deg, sun_elevation_deg    | real: NASA/JPL ephemerides (Skyfield)           |
| illumination                          | exact geometry (solar disk above the horizon)   |
| shadow_probability, dust_factor       | simulated, tunable (lunar_environment.py)       |
| panel_*, battery_soc_pct              | caller (defaults = data/sample_input.json)      |

Usage from the orchestrator / API:

    from backend.app.modules.data_twin.live_source import lunar_raw_input
    state = build_twin_state(lunar_raw_input())

CLI (writes a time series for training or replay):

    python -m backend.app.modules.data_twin.live_source --days 30 --step 60
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

from backend.app.core.config import ROOT_DIR
from backend.app.core.contracts import RawInput
from backend.app.modules.data_twin.ephemeris import (
    LUNAR_SITE_LAT_DEG,
    LUNAR_SITE_LON_DEG,
    sun_from_earth_orbit,
    sun_from_moon_series,
    to_utc,
)
from backend.app.modules.data_twin.lunar_environment import (
    disk_illumination,
    dust_factor,
    terrain_shadow_probability,
)
from backend.app.modules.data_twin.satellite_source import ISS_NORAD_ID, get_satellite_position

# Same panel and battery values as data/sample_input.json
DEFAULT_PANEL_TILT_DEG = 32.0
DEFAULT_PANEL_AZIMUTH_DEG = 120.0
DEFAULT_BATTERY_SOC_PCT = 41.0

DEFAULT_SERIES_PATH = ROOT_DIR / "data" / "processed" / "lunar_raw_inputs.json"


def lunar_raw_input_series(
    timestamps: list[datetime],
    *,
    panel_tilt_deg: float = DEFAULT_PANEL_TILT_DEG,
    panel_azimuth_deg: float = DEFAULT_PANEL_AZIMUTH_DEG,
    battery_soc_pct: float = DEFAULT_BATTERY_SOC_PCT,
    days_since_cleaning: float = 0.0,
    lat_deg: float = LUNAR_SITE_LAT_DEG,
    lon_deg: float = LUNAR_SITE_LON_DEG,
) -> list[RawInput]:
    """One RawInput per timestamp, real sun seen from the lunar base.

    Dust keeps accumulating along the series, starting from `days_since_cleaning`.
    """
    if not timestamps:
        return []
    suns = sun_from_moon_series(timestamps, lat_deg, lon_deg)
    start = min(sun.timestamp for sun in suns)
    inputs = []
    for sun in suns:
        elapsed_days = (sun.timestamp - start).total_seconds() / 86400.0
        inputs.append(RawInput(
            timestamp=sun.timestamp,
            sun_azimuth_deg=round(sun.azimuth_deg, 4),
            sun_elevation_deg=round(sun.elevation_deg, 4),
            panel_azimuth_deg=panel_azimuth_deg,
            panel_tilt_deg=panel_tilt_deg,
            battery_soc_pct=battery_soc_pct,
            illumination=round(disk_illumination(sun.elevation_deg), 4),
            shadow_probability=round(terrain_shadow_probability(sun.elevation_deg), 4),
            dust_factor=round(dust_factor(days_since_cleaning + elapsed_days), 4),
            observed_power_w=None,
        ))
    return inputs


def lunar_raw_input(when: datetime | None = None, **kwargs) -> RawInput:
    """RawInput for the lunar base at `when` (UTC, default: now)."""
    return lunar_raw_input_series([to_utc(when)], **kwargs)[0]


def lunar_raw_input_range(
    start: datetime | None = None, days: float = 30.0, step_minutes: float = 60.0, **kwargs
) -> list[RawInput]:
    """RawInput every `step_minutes` over `days` days, starting at `start` (default: now)."""
    if days <= 0 or step_minutes <= 0:
        raise ValueError("days and step_minutes must be > 0")
    start = to_utc(start)
    count = math.ceil(days * 1440 / step_minutes)
    timestamps = [start + timedelta(minutes=i * step_minutes) for i in range(count)]
    return lunar_raw_input_series(timestamps, **kwargs)


def orbital_raw_input(
    norad_id: int = ISS_NORAD_ID,
    *,
    panel_tilt_deg: float = DEFAULT_PANEL_TILT_DEG,
    panel_azimuth_deg: float = DEFAULT_PANEL_AZIMUTH_DEG,
    battery_soc_pct: float = DEFAULT_BATTERY_SOC_PCT,
) -> RawInput:
    """RawInput for a satellite right now: real position (N2YO) and real sun (Skyfield).

    In orbit there is no dust or terrain; the Earth's shadow sets illumination to 0.
    """
    sun = sun_from_earth_orbit(get_satellite_position(norad_id))
    return RawInput(
        timestamp=sun.timestamp,
        sun_azimuth_deg=round(sun.azimuth_deg, 4),
        sun_elevation_deg=round(sun.elevation_deg, 4),
        panel_azimuth_deg=panel_azimuth_deg,
        panel_tilt_deg=panel_tilt_deg,
        battery_soc_pct=battery_soc_pct,
        illumination=1.0 if sun.sunlit else 0.0,
        shadow_probability=0.0,
        dust_factor=1.0,
        observed_power_w=None,
    )


def write_series(inputs: list[RawInput], path: Path = DEFAULT_SERIES_PATH) -> Path:
    """Write RawInputs as a JSON list (same format as data/sample_input.json)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [item.model_dump(mode="json") for item in inputs]
    path.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Real lunar sun data in the RawInput format.")
    parser.add_argument("--days", type=float, default=30.0, help="series length in days")
    parser.add_argument("--step", type=float, default=60.0, help="time step in minutes")
    parser.add_argument("--out", type=Path, default=DEFAULT_SERIES_PATH)
    args = parser.parse_args()

    print("Now:", lunar_raw_input().model_dump_json(indent=2))
    series = lunar_raw_input_range(days=args.days, step_minutes=args.step)
    path = write_series(series, args.out)
    elevations = [item.sun_elevation_deg for item in series]
    print(f"\n{len(series)} rows written to {path}")
    print(f"Sun elevation: min {min(elevations):.2f} deg, max {max(elevations):.2f} deg")
