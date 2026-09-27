"""Lunar environment derived from the real sun position.

- illumination: exact geometry (fraction of the solar disk above the horizon).
  At the lunar south pole the sun skims the horizon, so this matters a lot.
- shadow_probability: simple, tunable terrain model (surrounding relief hides a low sun).
- dust_factor: simple, tunable model of dust accumulation since the last cleaning.
"""

from __future__ import annotations

import math

SOLAR_DISK_RADIUS_DEG = 0.2666  # apparent radius of the sun from the Earth-Moon system

# Terrain: below TERRAIN_CLEAR_ELEVATION_DEG the relief may hide the sun,
# up to MAX_TERRAIN_SHADOW when the sun is on the horizon.
TERRAIN_CLEAR_ELEVATION_DEG = 3.0
MAX_TERRAIN_SHADOW = 0.6

# Dust: panel transmission decays exponentially with days since the last cleaning.
DUST_DECAY_PER_DAY = 0.004  # about -11 % after 30 days
MIN_DUST_FACTOR = 0.5


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def disk_illumination(sun_elevation_deg: float) -> float:
    """Fraction (0-1) of the solar disk area above the local horizon."""
    h = _clamp(sun_elevation_deg / SOLAR_DISK_RADIUS_DEG, -1.0, 1.0)
    hidden = (math.acos(h) - h * math.sqrt(1.0 - h * h)) / math.pi
    return _clamp(1.0 - hidden)


def terrain_shadow_probability(sun_elevation_deg: float) -> float:
    """Probability (0-1) that surrounding relief shadows the panel."""
    if sun_elevation_deg >= TERRAIN_CLEAR_ELEVATION_DEG:
        return 0.0
    ratio = (TERRAIN_CLEAR_ELEVATION_DEG - max(sun_elevation_deg, 0.0)) / TERRAIN_CLEAR_ELEVATION_DEG
    return _clamp(MAX_TERRAIN_SHADOW * ratio)


def dust_factor(days_since_cleaning: float) -> float:
    """Panel transmission (1 = clean) after `days_since_cleaning` days of dust accumulation."""
    if days_since_cleaning < 0:
        raise ValueError("days_since_cleaning must be >= 0")
    return max(MIN_DUST_FACTOR, math.exp(-DUST_DECAY_PER_DAY * days_since_cleaning))
