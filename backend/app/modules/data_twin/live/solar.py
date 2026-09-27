"""Offline solar geometry and irradiance models used when no API answers.

Angle convention (same as TwinState): azimuth is a compass bearing, 0 = North, 90 = East,
180 = South, in [0, 360); elevation is in degrees above the horizon.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

SOLAR_CONSTANT_W_M2 = 1361.0

# Lunar south pole (site 0°E, 89.9°S) — fitted on JPL Horizons 2026 ephemerides:
# the Sun circles the horizon once per synodic month and its elevation swings ±1.54°
# over an eclipse year. Accuracy ≈ 2° in azimuth, 0.2° in elevation: fallback only.
_MOON_REF = datetime(2026, 9, 28, tzinfo=timezone.utc)
_MOON_REF_AZIMUTH_DEG = 339.336
_MOON_AZIMUTH_RATE_DEG_PER_DAY = -360.0 / 29.530589
_MOON_ELEVATION_AMPLITUDE_DEG = 1.54
_MOON_ELEVATION_ZERO_UP = datetime(2026, 8, 22, 15, tzinfo=timezone.utc)
_ECLIPSE_YEAR_DAYS = 346.62


def _days(a: datetime, b: datetime) -> float:
    return (a - b).total_seconds() / 86400.0


def earth_sun_position(when: datetime, lat_deg: float, lon_deg: float) -> tuple[float, float]:
    """NOAA general solar position (accuracy ≈ 0.5°). Returns (azimuth_deg, elevation_deg)."""
    when = when.astimezone(timezone.utc)
    day_of_year = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60.0 + when.second / 3600.0
    gamma = 2.0 * math.pi / 365.0 * (day_of_year - 1 + (hour - 12.0) / 24.0)
    eqtime_min = 229.18 * (
        0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma)
    )
    decl = (
        0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma)
    )
    true_solar_min = hour * 60.0 + eqtime_min + 4.0 * lon_deg
    hour_angle = math.radians(true_solar_min / 4.0 - 180.0)
    lat = math.radians(lat_deg)

    sin_el = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(hour_angle)
    elevation = math.degrees(math.asin(max(-1.0, min(1.0, sin_el))))
    azimuth_from_south = math.atan2(
        math.sin(hour_angle),
        math.cos(hour_angle) * math.sin(lat) - math.tan(decl) * math.cos(lat),
    )
    azimuth = (math.degrees(azimuth_from_south) + 180.0) % 360.0
    return azimuth, elevation


def local_solar_hour(when: datetime, lon_deg: float) -> float:
    """Local mean solar time in hours (the time standard of NASA POWER 'LST' files)."""
    when = when.astimezone(timezone.utc)
    return (when.hour + when.minute / 60.0 + when.second / 3600.0 + lon_deg / 15.0) % 24.0


def moon_south_pole_sun_position(when: datetime) -> tuple[float, float]:
    """Approximate Sun (azimuth_deg, elevation_deg) seen from the lunar south pole."""
    azimuth = (_MOON_REF_AZIMUTH_DEG + _MOON_AZIMUTH_RATE_DEG_PER_DAY * _days(when, _MOON_REF)) % 360.0
    phase = 2.0 * math.pi * _days(when, _MOON_ELEVATION_ZERO_UP) / _ECLIPSE_YEAR_DAYS
    return azimuth, _MOON_ELEVATION_AMPLITUDE_DEG * math.sin(phase)


def extraterrestrial_normal_w_m2(day_of_year: int) -> float:
    return SOLAR_CONSTANT_W_M2 * (1.0 + 0.033 * math.cos(2.0 * math.pi * day_of_year / 365.0))


def clear_sky_ghi_w_m2(elevation_deg: float) -> float:
    """Haurwitz clear-sky global horizontal irradiance."""
    sin_el = math.sin(math.radians(elevation_deg))
    if sin_el <= 0.0:
        return 0.0
    return 1098.0 * sin_el * math.exp(-0.057 / sin_el)


def decompose_ghi(ghi: float, elevation_deg: float, day_of_year: int) -> tuple[float, float]:
    """Erbs (1982) split of GHI into (DNI, DHI), DNI capped by a Meinel clear sky.

    Same model as the visual twin's replay (frontend/digital_twin/js/datasource.js).
    """
    sin_el = math.sin(math.radians(elevation_deg))
    if ghi <= 0.0:
        return 0.0, 0.0
    if sin_el <= 0.02:
        return 0.0, ghi
    i0 = extraterrestrial_normal_w_m2(day_of_year)
    kt = min(1.0, ghi / (i0 * sin_el))
    if kt <= 0.22:
        kd = 1.0 - 0.09 * kt
    elif kt <= 0.8:
        kd = 0.9511 - 0.1604 * kt + 4.388 * kt**2 - 16.638 * kt**3 + 12.336 * kt**4
    else:
        kd = 0.165
    dni_clear = i0 * math.pow(0.7, math.pow(1.0 / sin_el, 0.678))
    dni = min(dni_clear, (ghi - kd * ghi) / sin_el)
    return dni, ghi - dni * sin_el
