"""Real data sources (P1): NASA/JPL ephemerides with Skyfield, N2YO satellite API.

N2YO is always mocked: no API key or network access is needed.
Skyfield tests download the ephemeris files once (~19 MB) and are skipped when offline.
"""

import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from backend.app.core.contracts import RawInput
from backend.app.modules.data_twin import satellite_source
from backend.app.modules.data_twin.ephemeris import SunPosition, _skyfield, position_from_tle, sun_from_moon_series
from backend.app.modules.data_twin.live_source import lunar_raw_input, lunar_raw_input_range, lunar_raw_input_series
from backend.app.modules.data_twin.pipeline import build_twin_state

WHEN = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)
ISS_TLE = (
    "SPACE STATION",
    "1 25544U 98067A   26270.17419514  .00009528  00000-0  18291-3 0  9997",
    "2 25544  51.6315 155.3455 0007168 193.0560 167.0244 15.48664528587561",
)


def _ephemeris_available() -> bool:
    try:
        _skyfield()
        return True
    except Exception:
        return False


requires_ephemeris = pytest.mark.skipif(
    not _ephemeris_available(), reason="NASA ephemeris files unavailable (offline)"
)


# --- Sun seen from the Moon ------------------------------------------------------------

@requires_ephemeris
def test_sun_skims_horizon_at_lunar_south_pole():
    # Lunar axis is tilted by only 1.54 deg: at the pole the sun never leaves the horizon.
    stamps = [WHEN + timedelta(hours=6 * i) for i in range(4 * 30)]
    elevations = [sun.elevation_deg for sun in sun_from_moon_series(stamps, lat_deg=-90.0, lon_deg=0.0)]
    assert all(-2.0 < el < 2.0 for el in elevations)


@requires_ephemeris
def test_sun_reaches_zenith_region_at_lunar_equator():
    stamps = [WHEN + timedelta(hours=6 * i) for i in range(4 * 30)]
    elevations = [sun.elevation_deg for sun in sun_from_moon_series(stamps, lat_deg=0.0, lon_deg=0.0)]
    assert max(elevations) > 80.0
    assert min(elevations) < -80.0


@requires_ephemeris
def test_sun_azimuth_is_normalized():
    suns = sun_from_moon_series([WHEN + timedelta(hours=h) for h in range(0, 720, 12)])
    assert all(0.0 <= sun.azimuth_deg < 360.0 for sun in suns)


# --- RawInput built from real data -----------------------------------------------------

@requires_ephemeris
def test_lunar_raw_input_is_a_valid_contract():
    raw = lunar_raw_input(WHEN)
    assert isinstance(raw, RawInput)
    state = build_twin_state(raw)
    assert state.timestamp == WHEN
    assert state.environment.dust_factor == 1.0


@requires_ephemeris
def test_lunar_series_accumulates_dust():
    series = lunar_raw_input_range(WHEN, days=2, step_minutes=120)
    assert len(series) == 24
    assert series[-1].dust_factor < series[0].dust_factor
    assert [x.timestamp for x in series] == sorted(x.timestamp for x in series)


def test_lunar_series_rejects_invalid_range():
    with pytest.raises(ValueError):
        lunar_raw_input_range(WHEN, days=0)


def test_lunar_series_accepts_empty_timestamps():
    assert lunar_raw_input_series([]) == []


def test_lunar_series_uses_earliest_timestamp_for_dust(monkeypatch):
    suns = [
        SunPosition(timestamp=WHEN + timedelta(days=1), azimuth_deg=10.0, elevation_deg=5.0),
        SunPosition(timestamp=WHEN, azimuth_deg=20.0, elevation_deg=6.0),
    ]
    monkeypatch.setattr("backend.app.modules.data_twin.live_source.sun_from_moon_series", lambda *args, **kwargs: suns)
    series = lunar_raw_input_series([WHEN + timedelta(days=1), WHEN], days_since_cleaning=2.0)
    assert [item.timestamp for item in series] == [WHEN + timedelta(days=1), WHEN]
    assert all(0.0 <= item.dust_factor <= 1.0 for item in series)
    assert series[0].dust_factor < series[1].dust_factor


@requires_ephemeris
def test_iss_position_from_tle_is_on_its_orbit():
    position = position_from_tle(ISS_TLE, WHEN)
    assert -52.0 <= position.lat_deg <= 52.0  # ISS orbit inclination: 51.6 deg
    assert 350.0 < position.alt_km < 450.0


# --- N2YO client (mocked) --------------------------------------------------------------

class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


@pytest.fixture
def n2yo(monkeypatch, tmp_path):
    monkeypatch.setenv("N2YO_API_KEY", "test-key")
    satellite_source._position_cache.clear()
    cache = tmp_path / "tle_cache.json"
    cache.write_text(json.dumps({"25544": list(ISS_TLE)}), encoding="utf-8")
    yield cache
    satellite_source._position_cache.clear()


def test_position_is_parsed_and_cached(n2yo, monkeypatch):
    calls = []

    def fake_get(url, params, timeout):
        calls.append(url)
        return _FakeResponse({"positions": [{"satlatitude": 10.0, "satlongitude": 20.0, "sataltitude": 420.0}]})

    monkeypatch.setattr(satellite_source.httpx, "get", fake_get)
    first = satellite_source.get_satellite_position(25544, n2yo)
    second = satellite_source.get_satellite_position(25544, n2yo)
    assert (first.lat_deg, first.lon_deg, first.alt_km) == (10.0, 20.0, 420.0)
    assert second == first
    assert len(calls) == 1  # second call served from cache: free quota preserved


@requires_ephemeris
def test_position_falls_back_to_cached_orbit_when_offline(n2yo, monkeypatch):
    def offline(*args, **kwargs):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(satellite_source.httpx, "get", offline)
    position = satellite_source.get_satellite_position(25544, n2yo)
    assert -52.0 <= position.lat_deg <= 52.0


def test_n2yo_error_payload_is_reported(n2yo, monkeypatch):
    monkeypatch.setattr(satellite_source.httpx, "get", lambda *a, **k: _FakeResponse({"error": "Invalid API Key!"}))
    with pytest.raises(satellite_source.N2YOError, match="Invalid API Key"):
        satellite_source.get_satellite_tle(99999, n2yo)


def test_missing_api_key_is_reported(monkeypatch):
    monkeypatch.delenv("N2YO_API_KEY", raising=False)
    with pytest.raises(satellite_source.N2YOError, match="N2YO_API_KEY"):
        satellite_source._n2yo_get("tle/25544")


def test_received_tle_is_cached(n2yo, monkeypatch):
    payload = {"info": {"satname": "HST"}, "tle": "1 20580U line1\r\n2 20580 line2"}
    monkeypatch.setattr(satellite_source.httpx, "get", lambda *a, **k: _FakeResponse(payload))
    assert satellite_source.get_satellite_tle(20580, n2yo) == ("HST", "1 20580U line1", "2 20580 line2")
    assert json.loads(n2yo.read_text(encoding="utf-8"))["20580"][0] == "HST"
