"""Live data sources: simulated API answers only, no network call."""
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from backend.app.core.config import ROOT_DIR
from backend.app.modules.data_twin.live.replay import NasaPowerReplay, ReplayRecord
from backend.app.modules.data_twin.live import sources
from backend.app.modules.data_twin.live.sources import parse_swpc_wind, parse_swpc_xrays
from backend.app.modules.data_twin.live.service import LiveDataService

NOW = datetime(2026, 9, 27, 13, 57, tzinfo=timezone.utc)
REPLAY = ROOT_DIR / "data" / "nasa_power" / "ouarzazate-2024-06-power.json"

OPEN_METEO = {"current": {"time": "2026-09-27T13:45", "interval": 900, "temperature_2m": 30.2,
                          "wind_speed_10m": 0.91, "shortwave_radiation": 343.0, "direct_radiation": 25.0,
                          "diffuse_radiation": 318.0, "direct_normal_irradiance": 31.6}}
HORIZONS = {"signature": {"source": "NASA/JPL Horizons API", "version": "1.2"},
            "result": "header\n$$SOE\n 2026-Sep-27 13:57,*,i, 344.429788,     0.996716,\n$$EOE\nfooter"}
DONKI_FLR_QUIET = [{"flrID": "x", "beginTime": "2026-09-19T17:57Z", "peakTime": "2026-09-19T18:17Z", "classType": "C3.3"}]
DONKI_GST_QUIET = []
XRAYS_QUIET = [
    {"time_tag": "2026-09-27T13:53:00Z", "flux": 1e-9, "energy": "0.05-0.4nm"},
    {"time_tag": "2026-09-27T13:52:00Z", "flux": 6.0e-7, "energy": "0.1-0.8nm"},
    {"time_tag": "2026-09-27T13:53:00Z", "flux": 6.9e-7, "energy": "0.1-0.8nm"},
]
WIND = [{"time_tag": "2026-09-27T13:50:00", "active": False, "source": "ACE", "proton_speed": 470.0, "proton_density": 0.2},
        {"time_tag": "2026-09-27T13:50:00", "active": True, "source": "SOLAR1", "proton_speed": 396.3, "proton_density": 1.33}]
MAG = [{"time_tag": "2026-09-27T13:51:00", "active": True, "source": "SOLAR1", "bt": 2.6, "bz_gsm": -2.07}]


class FakeClock:
    def __init__(self, now=NOW):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, minutes):
        self.now += timedelta(minutes=minutes)


class FakeApis:
    """Routes each URL to a canned payload; a payload that is an exception is raised instead."""

    def __init__(self, **overrides):
        self.payloads = {
            sources.OPEN_METEO_URL: OPEN_METEO,
            sources.HORIZONS_URL: HORIZONS,
            sources.DONKI_URL.format(kind="FLR"): DONKI_FLR_QUIET,
            sources.DONKI_URL.format(kind="GST"): DONKI_GST_QUIET,
            sources.SWPC_XRAYS_URL: XRAYS_QUIET,
            sources.SWPC_WIND_URL: WIND,
            sources.SWPC_MAG_URL: MAG,
        }
        self.payloads.update({getattr(sources, k): v for k, v in overrides.items()})
        self.calls = []

    def __call__(self, url, params, headers):
        self.calls.append((url, {**params, **headers}))
        payload = self.payloads[url]
        if isinstance(payload, Exception):
            raise payload
        return payload

    def count(self, url):
        return sum(1 for u, _ in self.calls if u == url)

    def fail(self, url, exc=None):
        self.payloads[url] = exc or httpx.ConnectError("down")


def http_error(code, url="https://api.nasa.gov/DONKI/FLR?api_key=SECRET-KEY-123"):
    request = httpx.Request("GET", url)
    return httpx.HTTPStatusError(f"{code} for {url}", request=request, response=httpx.Response(code, request=request))


def make_service(apis, clock=None, replay_file=REPLAY, key="test-key"):
    return LiveDataService(get_json=apis, clock=clock or FakeClock(), nasa_api_key=key, replay_file=replay_file)


def test_earth_live_uses_open_meteo_and_marks_every_source():
    apis = FakeApis()
    data = make_service(apis).snapshot("earth")
    assert data.mode == "earth" and data.site.body == "earth"
    assert data.weather.ghi_w_m2 == 343.0 and data.weather.dni_w_m2 == 31.6 and data.weather.dhi_w_m2 == 318.0
    assert data.weather.ambient_c == 30.2 and data.weather.wind_m_s == 0.91
    assert data.weather.source.label == "Open-Meteo" and data.weather.source.status == "live"
    assert data.weather.source.observed_at == datetime(2026, 9, 27, 13, 45, tzinfo=timezone.utc)
    assert 0 <= data.sun.azimuth_deg < 360 and data.sun.elevation_deg > 40   # early afternoon in Ouarzazate
    sw = data.space_weather
    assert sw.level == "none" and sw.risk_flags == () and sw.recommended_action is None
    assert sw.xray_class == "B6.9" and sw.solar_wind_speed_km_s == 396.3 and sw.imf_bz_nt == -2.07
    assert {m.status for m in sw.sources} == {"live"}
    # Open-Meteo request asks for SI wind and the three irradiance components.
    params = next(p for u, p in apis.calls if u == sources.OPEN_METEO_URL)
    assert params["wind_speed_unit"] == "ms" and "direct_normal_irradiance" in params["current"]


def test_real_key_goes_in_header_with_15_min_donki_cache():
    apis, clock = FakeApis(), FakeClock()
    service = make_service(apis, clock, key="real-key")
    service.snapshot("earth")
    url, sent = next((u, p) for u, p in apis.calls if u == sources.DONKI_URL.format(kind="FLR"))
    assert sent.get("X-Api-Key") == "real-key" and "api_key" not in sent
    clock.advance(16)
    service.snapshot("earth")
    assert apis.count(sources.DONKI_URL.format(kind="FLR")) == 2


def test_cache_avoids_calls_within_ttl_then_refreshes():
    apis, clock = FakeApis(), FakeClock()
    service = make_service(apis, clock)
    service.snapshot("earth")
    clock.advance(4)
    service.snapshot("earth")
    assert apis.count(sources.OPEN_METEO_URL) == 1 and apis.count(sources.SWPC_XRAYS_URL) == 1
    clock.advance(7)   # 11 min: Open-Meteo (10 min) and X-rays (5 min) expired, DONKI (15 min) not
    data = service.snapshot("earth")
    assert apis.count(sources.OPEN_METEO_URL) == 2 and apis.count(sources.SWPC_XRAYS_URL) == 2
    assert apis.count(sources.DONKI_URL.format(kind="FLR")) == 1
    assert data.weather.source.status == "live" and data.weather.source.age_s == 0


def test_demo_key_slows_donki_to_respect_its_daily_quota():
    apis, clock = FakeApis(), FakeClock()
    service = make_service(apis, clock, key="")
    service.snapshot("earth")
    clock.advance(30)
    service.snapshot("earth")
    assert apis.count(sources.DONKI_URL.format(kind="FLR")) == 1
    assert any(p.get("X-Api-Key") == "DEMO_KEY" for _, p in apis.calls)


def test_api_failure_serves_last_known_value_as_cache():
    apis, clock = FakeApis(), FakeClock()
    service = make_service(apis, clock)
    service.snapshot("earth")
    apis.fail(sources.OPEN_METEO_URL, httpx.ReadTimeout("slow"))
    clock.advance(12)
    data = service.snapshot("earth")
    assert data.weather.ghi_w_m2 == 343.0
    assert data.weather.source.status == "cache" and data.weather.source.error == "timeout"
    assert data.weather.source.age_s == pytest.approx(12 * 60)
    # Back-off: a failed API is not called again on every request.
    calls = apis.count(sources.OPEN_METEO_URL)
    clock.advance(0.5)
    service.snapshot("earth")
    assert apis.count(sources.OPEN_METEO_URL) == calls


def test_no_cache_falls_back_to_nasa_power_replay_then_simulation():
    apis = FakeApis()
    apis.fail(sources.OPEN_METEO_URL)
    replay = make_service(apis).snapshot("earth").weather
    assert replay.source.status == "fallback" and replay.source.id == "nasa_power_replay"
    assert "NASA POWER" in replay.source.label and replay.source.error == "network error"
    assert replay.ghi_w_m2 > 0 and replay.ambient_c is not None

    simulated = make_service(apis, replay_file=None).snapshot("earth").weather
    assert simulated.source.status == "fallback" and simulated.source.id == "simulation"
    assert simulated.ghi_w_m2 > 0


def test_replay_uses_zero_based_day_of_year_mapping():
    replay = NasaPowerReplay(
        [
            ReplayRecord(
                datetime(2024, 1, 1, hour),
                100.0 + hour,
                None,
                20.0,
                1.0,
            )
            for hour in range(24)
        ]
        + [
            ReplayRecord(
                datetime(2024, 1, 2, hour),
                200.0 + hour,
                None,
                20.0,
                1.0,
            )
            for hour in range(24)
        ],
        lon_deg=0.0,
        label="test replay",
    )
    weather = replay.at(datetime(2026, 1, 2, 0, 0, tzinfo=timezone.utc))
    assert weather.ghi_w_m2 == 200.0


def test_replay_observed_at_tracks_interpolated_time():
    replay = NasaPowerReplay(
        [
            ReplayRecord(datetime(2024, 1, 1, 0), 100.0, None, 20.0, 1.0),
            ReplayRecord(datetime(2024, 1, 1, 1), 200.0, None, 20.0, 1.0),
        ],
        lon_deg=0.0,
        label="test replay",
    )
    weather = replay.at(datetime(2026, 1, 1, 0, 30, tzinfo=timezone.utc))
    assert weather.ghi_w_m2 == 150.0
    assert weather.observed_at == datetime(2024, 1, 1, 0, 30, tzinfo=timezone.utc)


def test_swpc_xrays_chooses_latest_sample_by_parsed_timestamp():
    value, observed_at = parse_swpc_xrays(
        [
            {"time_tag": "2026-09-27T14:00:00+01:00", "flux": 5.0e-7, "energy": "0.1-0.8nm"},
            {"time_tag": "2026-09-27T13:30:00Z", "flux": 6.0e-7, "energy": "0.1-0.8nm"},
        ],
        NOW,
    )
    assert value["flux_w_m2"] == pytest.approx(6.0e-7)
    assert observed_at == datetime(2026, 9, 27, 13, 30, tzinfo=timezone.utc)


def test_swpc_wind_chooses_latest_active_sample_by_parsed_timestamp():
    value, observed_at = parse_swpc_wind(
        [
            {"time_tag": "2026-09-27T14:00:00+01:00", "active": True, "proton_speed": 500.0},
            {"time_tag": "2026-09-27T13:40:00Z", "active": True, "proton_speed": 550.0, "proton_density": 1.2},
        ],
        NOW,
    )
    assert value["speed_km_s"] == pytest.approx(550.0)
    assert value["density_cm3"] == pytest.approx(1.2)
    assert observed_at == datetime(2026, 9, 27, 13, 40, tzinfo=timezone.utc)


def test_stale_cache_expires_into_fallback():
    apis, clock = FakeApis(), FakeClock()
    service = make_service(apis, clock)
    service.snapshot("earth")
    apis.fail(sources.OPEN_METEO_URL)
    clock.advance(4 * 60)   # beyond the 3 h max staleness of Open-Meteo
    assert service.snapshot("earth").weather.source.id == "nasa_power_replay"


def test_malformed_payload_is_a_failure_not_a_crash():
    apis = FakeApis(OPEN_METEO_URL={"current": {"time": "2026-09-27T13:45", "shortwave_radiation": None}},
                    HORIZONS_URL={"error": "Cannot interpret date"})
    service = make_service(apis)
    assert service.snapshot("earth").weather.source.status == "fallback"
    moon = service.snapshot("moon")
    assert moon.sun.source.id == "simulation" and "Horizons" in moon.sun.source.error


def test_moon_uses_horizons_and_airless_irradiance():
    data = make_service(FakeApis()).snapshot("moon")
    assert data.site.body == "moon" and data.site.lat_deg == pytest.approx(-89.9)
    assert data.sun.azimuth_deg == pytest.approx(344.429788) and data.sun.elevation_deg == pytest.approx(0.996716)
    assert data.sun.source.label == "JPL Horizons" and data.sun.source.status == "live"
    assert data.weather.dhi_w_m2 == 0 and data.weather.dni_w_m2 > 1300 and data.weather.ambient_c is None
    assert data.space_weather.validation_gate == "auto"


def test_moon_without_horizons_uses_simulated_ephemeris():
    apis = FakeApis()
    apis.fail(sources.HORIZONS_URL)
    sun = make_service(apis).snapshot("moon").sun
    assert sun.source.status == "fallback"
    # Fitted model stays within a few degrees of the real Horizons value at that instant.
    assert abs(sun.azimuth_deg - 344.43) < 3 and abs(sun.elevation_deg - 0.997) < 0.3


def test_strong_space_weather_raises_flag_and_stow_with_gate_by_mode():
    storm = FakeApis(
        SWPC_XRAYS_URL=[{"time_tag": "2026-09-27T13:53:00Z", "flux": 2.1e-4, "energy": "0.1-0.8nm"}],
    )
    storm.payloads[sources.DONKI_URL.format(kind="GST")] = [
        {"gstID": "g", "allKpIndex": [{"observedTime": "2026-09-27T09:00Z", "kpIndex": 7.33, "source": "NOAA"}]}]
    service = make_service(storm)
    earth = service.snapshot("earth").space_weather
    assert earth.level == "strong" and earth.risk_flags == ("SPACE_WEATHER",)
    assert earth.recommended_action == "STOW" and earth.validation_gate == "operator"
    assert earth.xray_class == "X2.1" and earth.max_kp_24h == pytest.approx(7.33)
    assert any("X2.1" in r for r in earth.reasons) and any("Kp 7.3" in r for r in earth.reasons)
    assert service.snapshot("moon").space_weather.validation_gate == "auto"


def test_moderate_space_weather_does_not_stow():
    apis = FakeApis(SWPC_WIND_URL=[{"time_tag": "2026-09-27T13:50:00", "active": True, "proton_speed": 650.0}])
    sw = make_service(apis).snapshot("earth").space_weather
    assert sw.level == "moderate" and sw.recommended_action is None and sw.risk_flags == ()


def test_old_events_outside_24h_are_ignored():
    apis = FakeApis()
    apis.payloads[sources.DONKI_URL.format(kind="FLR")] = [{"peakTime": "2026-09-25T10:00Z", "classType": "X1.0"}]
    assert make_service(apis).snapshot("earth").space_weather.level == "none"


def test_all_space_weather_sources_down_is_unknown_and_never_leaks_the_key():
    apis = FakeApis()
    for url in (sources.SWPC_XRAYS_URL, sources.SWPC_WIND_URL, sources.SWPC_MAG_URL):
        apis.fail(url)
    for kind in ("FLR", "GST"):
        apis.fail(sources.DONKI_URL.format(kind=kind), http_error(429))
    sw = make_service(apis, key="SECRET-KEY-123").snapshot("earth").space_weather
    assert sw.level == "unknown" and sw.recommended_action is None
    assert {m.status for m in sw.sources} == {"fallback"}
    donki = [m for m in sw.sources if m.id.startswith("donki")]
    assert all(m.error == "HTTP 429" for m in donki)
    assert "SECRET" not in sw.model_dump_json()


def test_live_route_returns_contract(client, monkeypatch):
    from backend.app.api import data as data_api

    monkeypatch.setattr(data_api, "live_data", make_service(FakeApis()))
    response = client.get("/api/v1/data/live", params={"mode": "moon"})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"schema_version", "mode", "generated_at", "site", "sun", "weather", "space_weather"}
    assert body["mode"] == "moon" and body["sun"]["source"]["status"] == "live"
    assert set(body["sun"]["source"]) >= {"label", "status", "updated_at", "age_s"}
    assert client.get("/api/v1/data/live").json()["mode"] == "earth"
    assert client.get("/api/v1/data/live", params={"mode": "mars"}).status_code == 422
