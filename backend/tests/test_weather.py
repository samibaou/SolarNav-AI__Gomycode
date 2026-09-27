from fastapi.testclient import TestClient
from backend.app.main import app

client = TestClient(app)


def _hourly_times():
    return [f"2026-09-27T{hour:02d}:00" for hour in range(24)] + [f"2026-09-28T{hour:02d}:00" for hour in range(24)]

def test_get_weather_forecast_endpoint(monkeypatch):
    """Vérifie le contrat avec des données Open-Meteo déterministes."""
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"hourly": {
                "time": _hourly_times(),
                "cloud_cover": [20.0] * 48,
                "precipitation": [0.0] * 48,
                "wind_speed_10m": [5.0] * 48,
                "direct_radiation": [600.0] * 48,
            }}

    monkeypatch.setattr(
        "backend.app.services.weather_forecaster.requests.get",
        lambda *args, **kwargs: FakeResponse(),
    )
    response = client.get("/api/v1/weather/forecast")
    
    assert response.status_code == 200
    data = response.json()
    
    # Vérification des clés de la réponse
    assert "status" in data
    assert "action_plan" in data
    assert "mode" in data
    assert "metrics" in data
    assert data["data_origin"] == "live"
    
    # Vérification des métriques chiffrées
    metrics = data["metrics"]
    assert "avg_cloud_pct" in metrics
    assert "max_wind_kmh" in metrics
    assert "expected_radiation_w_m2" in metrics
    assert metrics["expected_radiation_w_m2"] == 600.0


def test_get_weather_forecast_uses_next_calendar_day_slice(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"hourly": {
                "time": _hourly_times(),
                "cloud_cover": [5.0] * 24 + [95.0] * 24,
                "precipitation": [0.0] * 24 + [12.0] * 24,
                "wind_speed_10m": [10.0] * 24 + [80.0] * 24,
                "direct_radiation": [800.0] * 24 + [100.0] * 24,
            }}

    monkeypatch.setattr(
        "backend.app.services.weather_forecaster.requests.get",
        lambda *args, **kwargs: FakeResponse(),
    )
    response = client.get("/api/v1/weather/forecast")

    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "SAFETY_STOW"
    assert data["metrics"]["avg_cloud_pct"] == 95.0
    assert data["metrics"]["max_wind_kmh"] == 80.0
    assert data["metrics"]["expected_radiation_w_m2"] == 100.0


def test_get_weather_forecast_does_not_fabricate_metrics_when_unavailable(monkeypatch):
    def unavailable(*args, **kwargs):
        raise RuntimeError("offline")

    monkeypatch.setattr("backend.app.services.weather_forecaster.requests.get", unavailable)
    response = client.get("/api/v1/weather/forecast")

    assert response.status_code == 200
    data = response.json()
    assert data["data_origin"] == "unavailable"
    assert data["mode"] == "UNAVAILABLE"
    assert all(value is None for value in data["metrics"].values())