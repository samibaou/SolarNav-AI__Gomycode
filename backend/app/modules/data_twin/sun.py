"""Calcule la position du soleil (élévation, azimut) et l'éclairage avec Skyfield."""

from datetime import datetime, timezone

import numpy as np
import pandas as pd
from skyfield.api import EarthSatellite, Loader, wgs84

from backend.app.core.config import settings

# Éphéméride téléchargée une seule fois (~17 Mo) et mise en cache dans data/cache/
_load = Loader(str(settings.root_dir / "data" / "cache"))
_ts = _load.timescale()
_eph = None


def _ephemeris():
    global _eph
    if _eph is None:
        _eph = _load("de421.bsp")
    return _eph


def get_real_sun_angle(
    lat: float, lon: float, alt: float, when: datetime | None = None
) -> tuple[float, float, bool]:
    """Retourne (sun_elevation, sun_azimuth, is_sunlit) vus depuis (lat, lon, alt_km).

    - sun_elevation : hauteur du soleil au-dessus de l'horizon local, en degrés
      (négative si le soleil est sous l'horizon)
    - sun_azimuth : direction du soleil, 0-360°, 0 = nord, 90 = est
    - is_sunlit : False si le point est dans l'ombre de la Terre
    """
    eph = _ephemeris()
    earth, sun = eph["earth"], eph["sun"]
    t = _ts.from_datetime(when or datetime.now(timezone.utc))

    location = wgs84.latlon(lat, lon, elevation_m=alt * 1000)
    alt_angle, az_angle, _ = (earth + location).at(t).observe(sun).apparent().altaz()
    is_sunlit = bool(location.at(t).is_sunlit(eph))

    return alt_angle.degrees, az_angle.degrees, is_sunlit


def get_orbit_sun_angles(
    tle: tuple[str, str, str],
    n_points: int = 10_000,
    step_minutes: float = 1.0,
    start: datetime | None = None,
) -> pd.DataFrame:
    """Propage l'orbite réelle (TLE) et calcule le soleil vu du satellite à chaque pas.

    Renvoie un DataFrame (sat_lat, sat_lon, sat_alt, sun_elevation, sun_azimuth, is_sunlit)
    de n_points lignes espacées de step_minutes à partir de start (maintenant par défaut).
    Le TLE reste précis sur quelques jours : garder n_points * step_minutes raisonnable.
    """
    eph = _ephemeris()
    earth, sun = eph["earth"], eph["sun"]
    name, line1, line2 = tle
    satellite = EarthSatellite(line1, line2, name, _ts)

    start = start or datetime.now(timezone.utc)
    t = _ts.from_datetime(start) + np.arange(n_points) * step_minutes / 1440

    geocentric = satellite.at(t)
    location = wgs84.geographic_position_of(geocentric)
    alt_angle, az_angle, _ = (earth + location).at(t).observe(sun).apparent().altaz()

    return pd.DataFrame({
        "sat_lat": location.latitude.degrees,
        "sat_lon": location.longitude.degrees,
        "sat_alt": location.elevation.km,
        "sun_elevation": alt_angle.degrees,
        "sun_azimuth": az_angle.degrees,
        "is_sunlit": geocentric.is_sunlit(eph),
    })


if __name__ == "__main__":
    print(get_real_sun_angle(45.5, -73.6, 420))
