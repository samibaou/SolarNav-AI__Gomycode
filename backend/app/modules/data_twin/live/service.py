"""Live environment snapshot for the Digital Twin: Earth (Ouarzazate) or Moon (south pole).

Fallback chain, per data block, never raising:
  live API value → last known value (cache) → NASA POWER replay (Earth weather) → simulation.
"""
from __future__ import annotations

import math
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.app.core.config import ROOT_DIR  # also loads .env (NASA_API_KEY)
from backend.app.modules.data_twin.live import solar
from backend.app.modules.data_twin.live.models import (
    LiveData,
    LiveMode,
    LiveSite,
    LiveSun,
    LiveWeather,
    SourceMeta,
    SpaceWeather,
)
from backend.app.modules.data_twin.live.replay import NasaPowerReplay
from backend.app.modules.data_twin.live.sources import (
    EARTH_SITE,
    MOON_SITE,
    SWPC_MAG_URL,
    SWPC_WIND_URL,
    SWPC_XRAYS_URL,
    CachedSource,
    Clock,
    GetJson,
    SourceReading,
    SourceSpec,
    donki_request,
    horizons_request,
    http_get_json,
    open_meteo_request,
    parse_donki_flares,
    parse_donki_storms,
    parse_horizons,
    parse_open_meteo,
    parse_swpc_mag,
    parse_swpc_wind,
    parse_swpc_xrays,
    static_request,
)

DEFAULT_REPLAY_FILE = ROOT_DIR / "data" / "nasa_power" / "ouarzazate-2024-06-power.json"
DEMO_KEY = "DEMO_KEY"
MIN = 60.0

EARTH_ALBEDO = 0.25   # light desert ground (same as the visual twin's replay)
MOON_ALBEDO = 0.12    # lunar regolith
SIM_AMBIENT_C = 25.0
SIM_WIND_M_S = 3.0

# Space-weather thresholds (NOAA scales). strong ⇒ SPACE_WEATHER flag + STOW proposal.
XRAY_STRONG_W_M2 = 1e-4        # X1, radio blackout R3
XRAY_MODERATE_W_M2 = 5e-5      # M5, R2
KP_STRONG = 7.0                # G3
KP_MODERATE = 5.0              # G1
WIND_STRONG_KM_S = 700.0       # together with a southward IMF
WIND_MODERATE_KM_S = 600.0
BZ_SOUTH_NT = -10.0


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def xray_class(flux_w_m2: float) -> str:
    for letter, base in (("X", 1e-4), ("M", 1e-5), ("C", 1e-6), ("B", 1e-7)):
        if flux_w_m2 >= base:
            return f"{letter}{flux_w_m2 / base:.1f}"
    return f"A{flux_w_m2 / 1e-8:.1f}"


def _flare_level(cls: str) -> int:
    try:
        letter, size = cls[0].upper(), float(cls[1:])
    except (IndexError, ValueError):
        return 0
    if letter == "X":
        return 2
    return 1 if letter == "M" and size >= 5.0 else 0


class LiveDataService:
    def __init__(
        self,
        *,
        get_json: GetJson = http_get_json,
        clock: Clock = _utcnow,
        nasa_api_key: str | None = None,
        replay_file: Path | None = DEFAULT_REPLAY_FILE,
    ):
        self._clock = clock
        key = (nasa_api_key if nasa_api_key is not None else os.getenv("NASA_API_KEY", "")).strip() or DEMO_KEY
        # DEMO_KEY allows 50 requests/day per IP: 2 DONKI calls per hour stay under it.
        donki_ttl = 60 * MIN if key == DEMO_KEY else 15 * MIN
        specs = [
            SourceSpec("open_meteo", "Open-Meteo", 10 * MIN, 3 * 60 * MIN, open_meteo_request, parse_open_meteo),
            SourceSpec("jpl_horizons", "JPL Horizons", 5 * MIN, 60 * MIN, horizons_request, parse_horizons),
            SourceSpec("donki_flr", "NASA DONKI · éruptions", donki_ttl, 6 * 60 * MIN,
                       donki_request("FLR", key), parse_donki_flares, retry_after_s=15 * MIN),
            SourceSpec("donki_gst", "NASA DONKI · tempêtes", donki_ttl, 6 * 60 * MIN,
                       donki_request("GST", key), parse_donki_storms, retry_after_s=15 * MIN),
            SourceSpec("swpc_xrays", "NOAA SWPC · rayons X", 5 * MIN, 60 * MIN,
                       static_request(SWPC_XRAYS_URL), parse_swpc_xrays),
            SourceSpec("swpc_wind", "NOAA SWPC · vent solaire", 10 * MIN, 60 * MIN,
                       static_request(SWPC_WIND_URL), parse_swpc_wind),
            SourceSpec("swpc_mag", "NOAA SWPC · champ IMF", 10 * MIN, 60 * MIN,
                       static_request(SWPC_MAG_URL), parse_swpc_mag),
        ]
        self.sources = {s.id: CachedSource(s, get_json, clock) for s in specs}
        self._replay: NasaPowerReplay | None = None
        if replay_file is not None:
            try:
                self._replay = NasaPowerReplay.load(replay_file)
            except (OSError, ValueError, KeyError, TypeError):
                self._replay = None   # replay missing/invalid: chain goes straight to simulation
        self._pool = ThreadPoolExecutor(max_workers=len(specs), thread_name_prefix="live-data")

    def snapshot(self, mode: LiveMode) -> LiveData:
        primary = "open_meteo" if mode == "earth" else "jpl_horizons"
        ids = [primary, "donki_flr", "donki_gst", "swpc_xrays", "swpc_wind", "swpc_mag"]
        # Sources are read in parallel: a slow API costs one timeout, not the sum of all.
        readings = dict(zip(ids, self._pool.map(lambda i: self.sources[i].read(), ids)))
        now = self._clock()
        if mode == "earth":
            sun, weather = self._earth(now, readings["open_meteo"])
            site = LiveSite(name=EARTH_SITE["name"], body="earth", lat_deg=EARTH_SITE["lat"], lon_deg=EARTH_SITE["lon"])
        else:
            sun, weather = self._moon(now, readings["jpl_horizons"])
            site = LiveSite(name=MOON_SITE["name"], body="moon", lat_deg=MOON_SITE["lat"], lon_deg=MOON_SITE["lon"])
        return LiveData(
            mode=mode, generated_at=now, site=site, sun=sun, weather=weather,
            space_weather=self._space_weather(now, mode, readings),
        )

    # ---------- metadata ----------

    @staticmethod
    def _meta(now: datetime, reading: SourceReading) -> SourceMeta:
        fetched = reading.fetched_at or now
        return SourceMeta(
            id=reading.spec.id, label=reading.spec.label,
            status="fallback" if reading.value is None else reading.status,   # type: ignore[arg-type]
            updated_at=fetched, observed_at=reading.observed_at,
            age_s=max(0.0, (now - fetched).total_seconds()), error=reading.error,
        )

    @staticmethod
    def _fallback_meta(now: datetime, id_: str, label: str, error: str | None,
                       observed_at: datetime | None = None, status: str = "fallback") -> SourceMeta:
        return SourceMeta(id=id_, label=label, status=status, updated_at=now,   # type: ignore[arg-type]
                          observed_at=observed_at, age_s=0.0, error=error)

    # ---------- Earth ----------

    def _earth(self, now: datetime, reading: SourceReading) -> tuple[LiveSun, LiveWeather]:
        azimuth, elevation = solar.earth_sun_position(now, EARTH_SITE["lat"], EARTH_SITE["lon"])
        # Computed ephemeris: exact for "now", no network needed, so always current.
        sun = LiveSun(azimuth_deg=azimuth, elevation_deg=elevation,
                      source=self._fallback_meta(now, "noaa_solar_calc", "Éphéméride NOAA (calcul)", None, status="live"))
        clear = solar.clear_sky_ghi_w_m2(elevation)
        doy = now.timetuple().tm_yday

        def cloud(ghi: float, ghi_clear: float | None) -> float | None:
            ref = ghi_clear if ghi_clear is not None else clear
            return max(0.0, min(1.0, ghi / ref)) if ref > 20.0 else None

        if reading.value is not None:
            v = reading.value
            weather = LiveWeather(
                ghi_w_m2=v["ghi_w_m2"], dni_w_m2=v["dni_w_m2"], dhi_w_m2=v["dhi_w_m2"], ghi_clear_w_m2=clear,
                albedo=EARTH_ALBEDO, ambient_c=v["ambient_c"], wind_m_s=v["wind_m_s"],
                cloud_factor=cloud(v["ghi_w_m2"], None), source=self._meta(now, reading),
            )
        elif self._replay is not None:
            r = self._replay.at(now)
            dni, dhi = solar.decompose_ghi(r.ghi_w_m2, elevation, doy)
            weather = LiveWeather(
                ghi_w_m2=r.ghi_w_m2, dni_w_m2=dni, dhi_w_m2=max(0.0, dhi), ghi_clear_w_m2=r.ghi_clear_w_m2,
                albedo=EARTH_ALBEDO, ambient_c=r.ambient_c, wind_m_s=r.wind_m_s,
                cloud_factor=cloud(r.ghi_w_m2, r.ghi_clear_w_m2),
                source=self._fallback_meta(now, "nasa_power_replay", self._replay.label, reading.error, r.observed_at),
            )
        else:
            dni, dhi = solar.decompose_ghi(clear, elevation, doy)
            weather = LiveWeather(
                ghi_w_m2=clear, dni_w_m2=dni, dhi_w_m2=max(0.0, dhi), ghi_clear_w_m2=clear,
                albedo=EARTH_ALBEDO, ambient_c=SIM_AMBIENT_C, wind_m_s=SIM_WIND_M_S, cloud_factor=1.0,
                source=self._fallback_meta(now, "simulation", "Simulation (ciel clair)", reading.error),
            )
        return sun, weather

    # ---------- Moon ----------

    def _moon(self, now: datetime, reading: SourceReading) -> tuple[LiveSun, LiveWeather]:
        if reading.value is not None:
            azimuth, elevation = reading.value["azimuth_deg"], reading.value["elevation_deg"]
            meta = self._meta(now, reading)
        else:
            azimuth, elevation = solar.moon_south_pole_sun_position(now)
            meta = self._fallback_meta(now, "simulation", "Simulation (éphéméride approchée)", reading.error)
        sun = LiveSun(azimuth_deg=azimuth, elevation_deg=elevation, source=meta)
        # No atmosphere: all direct light at the solar constant, no diffuse, no wind.
        dni = solar.extraterrestrial_normal_w_m2(now.timetuple().tm_yday) if elevation > 0.0 else 0.0
        ghi = dni * max(0.0, math.sin(math.radians(elevation)))
        weather = LiveWeather(
            ghi_w_m2=ghi, dni_w_m2=dni, dhi_w_m2=0.0, ghi_clear_w_m2=ghi, albedo=MOON_ALBEDO,
            ambient_c=None, wind_m_s=0.0, cloud_factor=1.0,
            source=meta.model_copy(update={"id": "airless_model", "label": f"Vide spatial · soleil {meta.label}"}),
        )
        return sun, weather

    # ---------- Space weather ----------

    def _space_weather(self, now: datetime, mode: LiveMode, readings: dict[str, SourceReading]) -> SpaceWeather:
        def value(id_: str, key: str) -> Any:
            v = readings[id_].value
            return None if v is None else v.get(key)

        flux = value("swpc_xrays", "flux_w_m2")
        flares = tuple(value("donki_flr", "flares") or ())
        kp = value("donki_gst", "max_kp")
        speed = value("swpc_wind", "speed_km_s")
        density = value("swpc_wind", "density_cm3")
        bz = value("swpc_mag", "bz_nt")

        level, reasons = 0, []

        def raise_to(new_level: int, reason: str) -> None:
            nonlocal level
            level = max(level, new_level)
            reasons.append(reason)

        if flux is not None and flux >= XRAY_MODERATE_W_M2:
            raise_to(2 if flux >= XRAY_STRONG_W_M2 else 1, f"Flux X {xray_class(flux)}")
        for cls in flares:
            if _flare_level(cls):
                raise_to(_flare_level(cls), f"Éruption {cls} (24 h)")
        if kp is not None and kp >= KP_MODERATE:
            raise_to(2 if kp >= KP_STRONG else 1, f"Kp {kp:.1f} (24 h)")
        if speed is not None and bz is not None and speed >= WIND_STRONG_KM_S and bz <= BZ_SOUTH_NT:
            raise_to(2, f"Vent solaire {speed:.0f} km/s, Bz {bz:.1f} nT")
        elif (speed is not None and speed >= WIND_MODERATE_KM_S) or (bz is not None and bz <= BZ_SOUTH_NT):
            raise_to(1, f"Vent solaire {speed or 0:.0f} km/s, Bz {bz if bz is not None else 0:.1f} nT")

        ids = ("donki_flr", "donki_gst", "swpc_xrays", "swpc_wind", "swpc_mag")
        known = any(readings[i].value is not None for i in ids)
        name = ("none", "moderate", "strong")[level] if known else "unknown"
        strong = name == "strong"
        return SpaceWeather(
            level=name,
            risk_flags=("SPACE_WEATHER",) if strong else (),
            recommended_action="STOW" if strong else None,
            # Moon: no magnetosphere nor atmosphere, the policy stows at once.
            # Earth: the hazard is mostly indirect, so an operator validates only a strong-event STOW.
            validation_gate="operator" if mode == "earth" and strong else "auto",
            reasons=tuple(reasons),
            xray_flux_w_m2=flux, xray_class=xray_class(flux) if flux is not None else None,
            solar_wind_speed_km_s=speed, solar_wind_density_cm3=density, imf_bz_nt=bz,
            max_kp_24h=kp, flares_24h=flares,
            sources=tuple(self._meta(now, readings[i]) for i in ids),
        )
