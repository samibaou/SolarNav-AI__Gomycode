"""Real satellite position and orbit (TLE) from the N2YO REST API.

- Needs N2YO_API_KEY in the root .env (free key on n2yo.com).
- Positions are reused for POSITION_CACHE_SECONDS to save the free quota (~1000 requests/hour).
- Every TLE received is cached in data/tle_cache.json: when N2YO is unreachable, the
  position is propagated from the cached orbit instead (a TLE stays accurate for days).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from threading import RLock

import httpx

from backend.app.core.config import ROOT_DIR
from backend.app.modules.data_twin.ephemeris import GeoPosition, position_from_tle

N2YO_BASE_URL = "https://api.n2yo.com/rest/v1/satellite"
N2YO_TIMEOUT_SECONDS = 30.0  # N2YO sometimes takes more than 10 s to answer
POSITION_CACHE_SECONDS = 10.0
TLE_CACHE_PATH = ROOT_DIR / "data" / "tle_cache.json"

ISS_NORAD_ID = 25544

_position_cache: dict[int, tuple[float, GeoPosition]] = {}
_tle_cache_lock = RLock()


class N2YOError(RuntimeError):
    """N2YO is unreachable or returned an error payload."""


def _api_key() -> str:
    key = os.getenv("N2YO_API_KEY", "").strip()
    if not key:
        raise N2YOError("N2YO_API_KEY is missing: add it to the root .env file.")
    return key


def _n2yo_get(path: str) -> dict:
    try:
        response = httpx.get(
            f"{N2YO_BASE_URL}/{path}",
            params={"apiKey": _api_key()},
            timeout=N2YO_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPError as exc:
        raise N2YOError(f"N2YO request failed on {path}: {exc}") from exc

    # N2YO answers 200 with {"error": "..."} for an invalid key or satellite id
    if "error" in payload:
        raise N2YOError(f"N2YO error on {path}: {payload['error']}")
    return payload


def _read_tle_cache(path: Path) -> dict:
    with _tle_cache_lock:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}


def get_satellite_tle(norad_id: int, cache_path: Path = TLE_CACHE_PATH) -> tuple[str, str, str]:
    """Return (name, line1, line2); falls back to the cached TLE when N2YO is unreachable."""
    cache = _read_tle_cache(cache_path)
    try:
        payload = _n2yo_get(f"tle/{norad_id}")
        lines = payload.get("tle", "").splitlines()
        if len(lines) != 2:
            raise N2YOError(f"Invalid TLE for NORAD {norad_id}: {payload}")
        tle = [payload["info"]["satname"], lines[0].strip(), lines[1].strip()]
    except N2YOError:
        if str(norad_id) not in cache:
            raise
        return tuple(cache[str(norad_id)])

    with _tle_cache_lock:
        cache = _read_tle_cache(cache_path)
        cache[str(norad_id)] = tle
        cache_path.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    return tuple(tle)


def get_satellite_position(norad_id: int, cache_path: Path = TLE_CACHE_PATH) -> GeoPosition:
    """Current position of the satellite (N2YO), propagated from its TLE when N2YO is down."""
    cached = _position_cache.get(norad_id)
    if cached and time.monotonic() - cached[0] < POSITION_CACHE_SECONDS:
        return cached[1]

    try:
        # The /positions endpoint requires an observer; it does not affect the satellite position.
        payload = _n2yo_get(f"positions/{norad_id}/0/0/0/1/")
        if not payload.get("positions"):
            raise N2YOError(f"No N2YO position for NORAD {norad_id}: {payload}")
        point = payload["positions"][0]
        position = GeoPosition(point["satlatitude"], point["satlongitude"], point["sataltitude"])
    except N2YOError:
        position = position_from_tle(get_satellite_tle(norad_id, cache_path))

    _position_cache[norad_id] = (time.monotonic(), position)
    return position
