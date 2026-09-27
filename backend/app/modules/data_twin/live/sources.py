"""External real-time sources: request, parsing and per-source cache.

Checked formats (2026-09-27):
- Open-Meteo  GET https://api.open-meteo.com/v1/forecast?current=...  → {"current": {"time", ...}}
  (radiation values are the mean of the preceding 15 minutes)
- JPL Horizons GET https://ssd.jpl.nasa.gov/api/horizons.api (format=json, QUANTITIES='4', CSV)
  → {"result": "... $$SOE\\n date,*,i, azimuth, elevation,\\n $$EOE ..."}
- NASA DONKI  GET https://api.nasa.gov/DONKI/FLR | /GST ?startDate&endDate, header X-Api-Key → JSON list
- NOAA SWPC   GET https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json
              GET https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json | rtsw_mag_1m.json
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any, Callable

import httpx

Headers = dict[str, str]
GetJson = Callable[[str, dict[str, str], Headers], Any]
Request = tuple[str, dict[str, str], Headers]
Clock = Callable[[], datetime]

HTTP_TIMEOUT_S = 8.0
USER_AGENT = "SolarNav-AI/1.0 (hackathon digital twin)"

EARTH_SITE = {"name": "Ouarzazate — Noor", "lat": 30.92, "lon": -6.89}
MOON_SITE = {"name": "Pôle Sud lunaire", "lat": -89.9, "lon": 0.0}

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
DONKI_URL = "https://api.nasa.gov/DONKI/{kind}"
SWPC_XRAYS_URL = "https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json"
SWPC_WIND_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json"
SWPC_MAG_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json"


def http_get_json(url: str, params: dict[str, str], headers: Headers) -> Any:
    response = httpx.get(url, params=params, timeout=HTTP_TIMEOUT_S, headers={"User-Agent": USER_AGENT, **headers})
    response.raise_for_status()
    return response.json()


def describe_error(exc: Exception) -> str:
    """Short error text safe to show in the UI (never echoes URLs, which may carry the API key)."""
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}"
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, httpx.HTTPError):
        return "network error"
    return f"{type(exc).__name__}: {exc}"[:160]


def _utc(text: str) -> datetime:
    """Parse the ISO-like timestamps of the APIs ('...Z', '+00:00' or naive UTC)."""
    value = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} missing or not a number")
    return float(value)


# ---------- Open-Meteo (Earth weather) ----------

def open_meteo_request(now: datetime) -> Request:
    return OPEN_METEO_URL, {
        "latitude": str(EARTH_SITE["lat"]),
        "longitude": str(EARTH_SITE["lon"]),
        "current": "temperature_2m,wind_speed_10m,shortwave_radiation,direct_radiation,"
        "diffuse_radiation,direct_normal_irradiance",
        "wind_speed_unit": "ms",
        "timezone": "GMT",
    }, {}


def parse_open_meteo(payload: Any, now: datetime) -> tuple[dict[str, float], datetime]:
    current = payload["current"]
    value = {
        "ghi_w_m2": max(0.0, _number(current.get("shortwave_radiation"), "shortwave_radiation")),
        "dni_w_m2": max(0.0, _number(current.get("direct_normal_irradiance"), "direct_normal_irradiance")),
        "dhi_w_m2": max(0.0, _number(current.get("diffuse_radiation"), "diffuse_radiation")),
        "ambient_c": _number(current.get("temperature_2m"), "temperature_2m"),
        "wind_m_s": max(0.0, _number(current.get("wind_speed_10m"), "wind_speed_10m")),
    }
    return value, _utc(current["time"])


# ---------- JPL Horizons (Sun seen from the lunar south pole) ----------

_MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}


def horizons_request(now: datetime) -> Request:
    start = now.astimezone(timezone.utc).replace(second=0, microsecond=0)
    fmt = "%Y-%m-%d %H:%M"
    return HORIZONS_URL, {
        "format": "json",
        "COMMAND": "'10'",                       # the Sun
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'",                 # topocentric site on the Moon
        "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{MOON_SITE['lon']},{MOON_SITE['lat']},0'",   # E-lon, lat, altitude (km)
        "START_TIME": f"'{start.strftime(fmt)}'",
        "STOP_TIME": f"'{(start + timedelta(minutes=1)).strftime(fmt)}'",
        "STEP_SIZE": "'1m'",
        "QUANTITIES": "'4'",                     # apparent azimuth & elevation (airless: no refraction)
        "ANG_FORMAT": "'DEG'",
        "CSV_FORMAT": "'YES'",
    }, {}


def parse_horizons(payload: Any, now: datetime) -> tuple[dict[str, float], datetime]:
    if payload.get("error"):
        raise ValueError(f"Horizons: {str(payload['error'])[:120]}")
    text = payload["result"]
    start, end = text.find("$$SOE"), text.find("$$EOE")
    if start < 0 or end < 0:
        raise ValueError("Horizons: no ephemeris block ($$SOE)")
    line = next((l for l in text[start + 5:end].splitlines() if l.strip()), None)
    if line is None:
        raise ValueError("Horizons: empty ephemeris")
    fields = [f.strip() for f in line.split(",")]
    date_part, time_part = fields[0].split()
    year, month, day = date_part.split("-")
    hour, minute = time_part.split(":")[:2]
    observed = datetime(int(year), _MONTHS[month], int(day), int(hour), int(minute), tzinfo=timezone.utc)
    azimuth, elevation = float(fields[3]), float(fields[4])
    return {"azimuth_deg": azimuth % 360.0, "elevation_deg": elevation}, observed


# ---------- NASA DONKI (flares, geomagnetic storms) ----------

def donki_request(kind: str, api_key: str) -> Callable[[datetime], Request]:
    # Key sent as a header (api.data.gov X-Api-Key), never in the URL: URLs end up in logs and error texts.
    def build(now: datetime) -> Request:
        day = now.astimezone(timezone.utc).date()
        return DONKI_URL.format(kind=kind), {
            "startDate": (day - timedelta(days=1)).isoformat(),
            "endDate": day.isoformat(),
        }, {"X-Api-Key": api_key}
    return build


def parse_donki_flares(payload: Any, now: datetime) -> tuple[dict[str, Any], datetime | None]:
    if not isinstance(payload, list):
        raise ValueError("DONKI FLR: list expected")
    since = now - timedelta(hours=24)
    flares = []
    for flare in payload:
        stamp = flare.get("peakTime") or flare.get("beginTime")
        if stamp and flare.get("classType") and _utc(stamp) >= since:
            flares.append((_utc(stamp), str(flare["classType"])))
    flares.sort()
    return {"flares": [cls for _, cls in flares]}, flares[-1][0] if flares else None


def parse_donki_storms(payload: Any, now: datetime) -> tuple[dict[str, Any], datetime | None]:
    if not isinstance(payload, list):
        raise ValueError("DONKI GST: list expected")
    since = now - timedelta(hours=24)
    readings = [
        (_utc(k["observedTime"]), float(k["kpIndex"]))
        for storm in payload
        for k in storm.get("allKpIndex") or []
        if k.get("observedTime") and isinstance(k.get("kpIndex"), (int, float)) and _utc(k["observedTime"]) >= since
    ]
    readings.sort()
    return {"max_kp": max((kp for _, kp in readings), default=None)}, readings[-1][0] if readings else None


# ---------- NOAA SWPC (GOES X-rays, real-time solar wind) ----------

def static_request(url: str) -> Callable[[datetime], Request]:
    return lambda now: (url, {}, {})


def parse_swpc_xrays(payload: Any, now: datetime) -> tuple[dict[str, float], datetime]:
    long_band = [r for r in payload if r.get("energy") == "0.1-0.8nm" and isinstance(r.get("flux"), (int, float))]
    if not long_band:
        raise ValueError("SWPC X-rays: no 0.1-0.8nm flux")
    latest = max(long_band, key=lambda r: _utc(r["time_tag"]))
    return {"flux_w_m2": float(latest["flux"])}, _utc(latest["time_tag"])


def _latest_active(payload: Any, field: str, name: str) -> dict[str, Any]:
    rows = [r for r in payload if r.get("active") and isinstance(r.get(field), (int, float))]
    if not rows:
        raise ValueError(f"SWPC {name}: no active record")
    return max(rows, key=lambda r: _utc(r["time_tag"]))


def parse_swpc_wind(payload: Any, now: datetime) -> tuple[dict[str, float | None], datetime]:
    row = _latest_active(payload, "proton_speed", "solar wind")
    density = row.get("proton_density")
    return {
        "speed_km_s": float(row["proton_speed"]),
        "density_cm3": float(density) if isinstance(density, (int, float)) else None,
    }, _utc(row["time_tag"])


def parse_swpc_mag(payload: Any, now: datetime) -> tuple[dict[str, float], datetime]:
    row = _latest_active(payload, "bz_gsm", "magnetic field")
    return {"bz_nt": float(row["bz_gsm"])}, _utc(row["time_tag"])


# ---------- Cache ----------

@dataclass(frozen=True)
class SourceSpec:
    id: str
    label: str
    ttl_s: float                  # a fresh value is reused without calling the API
    max_stale_s: float            # beyond this age the last known value is no longer trusted
    request: Callable[[datetime], Request]
    parse: Callable[[Any, datetime], tuple[dict[str, Any], datetime | None]]
    retry_after_s: float = 60.0   # back-off after a failure, so a dead API is not hammered


@dataclass(frozen=True)
class SourceReading:
    spec: SourceSpec
    value: dict[str, Any] | None  # None: no live nor cached value usable
    status: str                   # 'live' | 'cache' | 'none'
    fetched_at: datetime | None
    observed_at: datetime | None
    error: str | None


class CachedSource:
    """One external source: TTL cache, failure back-off and last-known-value fallback. Thread-safe."""

    def __init__(self, spec: SourceSpec, get_json: GetJson, clock: Clock):
        self.spec = spec
        self._get_json = get_json
        self._clock = clock
        self._lock = Lock()
        self._value: dict[str, Any] | None = None
        self._fetched_at: datetime | None = None
        self._observed_at: datetime | None = None
        self._error: str | None = None
        self._retry_at: datetime | None = None

    def read(self) -> SourceReading:
        with self._lock:
            now = self._clock()
            if self._fetched_at and (now - self._fetched_at).total_seconds() < self.spec.ttl_s:
                return self._reading("live")
            if self._retry_at is None or now >= self._retry_at:
                try:
                    url, params, headers = self.spec.request(now)
                    value, observed = self.spec.parse(self._get_json(url, params, headers), now)
                    self._value, self._fetched_at, self._observed_at = value, now, observed
                    self._error, self._retry_at = None, None
                    return self._reading("live")
                except Exception as exc:  # any failure (network, HTTP, format) must degrade, never raise
                    self._error = describe_error(exc)
                    self._retry_at = now + timedelta(seconds=self.spec.retry_after_s)
            if self._fetched_at and (now - self._fetched_at).total_seconds() <= self.spec.max_stale_s:
                return self._reading("cache")
            return SourceReading(self.spec, None, "none", self._fetched_at, self._observed_at, self._error)

    def _reading(self, status: str) -> SourceReading:
        return SourceReading(self.spec, self._value, status, self._fetched_at, self._observed_at,
                             self._error if status == "cache" else None)
