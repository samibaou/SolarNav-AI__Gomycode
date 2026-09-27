"""Real sun position from NASA/JPL ephemerides (Skyfield).

Observers:
- a lunar base (default: lunar south pole, the Artemis target region);
- a satellite in Earth orbit (position given by N2YO or propagated from its TLE).

Ephemeris files (~19 MB) are downloaded once into data/ephemeris/ (ignored by Git).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache

import numpy as np
from skyfield.api import EarthSatellite, Loader, PlanetaryConstants, wgs84

from backend.app.core.config import ROOT_DIR

EPHEMERIS_DIR = ROOT_DIR / "data" / "ephemeris"

# Default lunar site: south pole region. Override with SOLARNAV_LUNAR_LAT_DEG / _LON_DEG.
LUNAR_SITE_LAT_DEG = float(os.getenv("SOLARNAV_LUNAR_LAT_DEG", "-89.5"))
LUNAR_SITE_LON_DEG = float(os.getenv("SOLARNAV_LUNAR_LON_DEG", "0.0"))

_PLANETS_FILE = "de421.bsp"
_MOON_FILES = ("moon_080317.tf", "pck00008.tpc", "moon_pa_de421_1900-2050.bpc")
_MOON_FRAME = "MOON_ME_DE421"


@dataclass(frozen=True)
class SunPosition:
    timestamp: datetime
    azimuth_deg: float
    elevation_deg: float
    sunlit: bool | None = None  # Earth-shadow flag, only for orbital observers


@dataclass(frozen=True)
class GeoPosition:
    lat_deg: float
    lon_deg: float
    alt_km: float


@lru_cache(maxsize=1)
def _skyfield():
    """Load timescale, planetary ephemeris and lunar body-fixed frame once."""
    EPHEMERIS_DIR.mkdir(parents=True, exist_ok=True)
    load = Loader(str(EPHEMERIS_DIR), verbose=False)
    ts = load.timescale()
    eph = load(_PLANETS_FILE)

    constants = PlanetaryConstants()
    constants.read_text(load(_MOON_FILES[0]))
    constants.read_text(load(_MOON_FILES[1]))
    constants.read_binary(load(_MOON_FILES[2]))
    moon_frame = constants.build_frame_named(_MOON_FRAME)
    return ts, eph, constants, moon_frame


def to_utc(when: datetime | None) -> datetime:
    """Timezone-aware UTC datetime (naive datetimes are assumed to be UTC)."""
    when = when or datetime.now(timezone.utc)
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def sun_from_moon(
    when: datetime | None = None,
    lat_deg: float = LUNAR_SITE_LAT_DEG,
    lon_deg: float = LUNAR_SITE_LON_DEG,
) -> SunPosition:
    """Sun azimuth/elevation seen from a lunar base at `when` (UTC, default: now)."""
    return sun_from_moon_series([to_utc(when)], lat_deg, lon_deg)[0]


def sun_from_moon_series(
    timestamps: list[datetime],
    lat_deg: float = LUNAR_SITE_LAT_DEG,
    lon_deg: float = LUNAR_SITE_LON_DEG,
) -> list[SunPosition]:
    """Vectorized sun_from_moon for a list of timestamps (one Skyfield call)."""
    ts, eph, constants, moon_frame = _skyfield()
    stamps = [to_utc(x) for x in timestamps]
    site = eph["moon"] + constants.build_latlon_degrees(moon_frame, lat_deg, lon_deg)
    alt, az, _ = site.at(ts.from_datetimes(stamps)).observe(eph["sun"]).apparent().altaz()
    return [
        SunPosition(timestamp=stamp, azimuth_deg=float(a), elevation_deg=float(e))
        for stamp, a, e in zip(stamps, np.atleast_1d(az.degrees), np.atleast_1d(alt.degrees))
    ]


def sun_from_earth_orbit(position: GeoPosition, when: datetime | None = None) -> SunPosition:
    """Sun seen from a satellite at `position`, plus whether it is in the Earth's shadow."""
    ts, eph, _, _ = _skyfield()
    when = to_utc(when)
    t = ts.from_datetime(when)
    location = wgs84.latlon(position.lat_deg, position.lon_deg, elevation_m=position.alt_km * 1000.0)
    alt, az, _ = (eph["earth"] + location).at(t).observe(eph["sun"]).apparent().altaz()
    return SunPosition(when, float(az.degrees), float(alt.degrees), bool(location.at(t).is_sunlit(eph)))


def position_from_tle(tle: tuple[str, str, str], when: datetime | None = None) -> GeoPosition:
    """Propagate a TLE (name, line1, line2) to `when` and return the sub-satellite position."""
    ts, _, _, _ = _skyfield()
    name, line1, line2 = tle
    geocentric = EarthSatellite(line1, line2, name, ts).at(ts.from_datetime(to_utc(when)))
    point = wgs84.geographic_position_of(geocentric)
    return GeoPosition(float(point.latitude.degrees), float(point.longitude.degrees), float(point.elevation.km))
