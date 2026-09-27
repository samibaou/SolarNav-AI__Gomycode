from fastapi.testclient import TestClient
from backend.app.main import app

client = TestClient(app)

def test_get_weather_forecast_endpoint():
    """Vérifie que l'endpoint HTTP /api/v1/weather/forecast répond correctement (Code 200)."""
    response = client.get("/api/v1/weather/forecast")
    
    assert response.status_code == 200
    data = response.json()
    
    # Vérification des clés de la réponse
    assert "status" in data
    assert "action_plan" in data
    assert "mode" in data
    assert "metrics" in data
    
    # Vérification des métriques chiffrées
    metrics = data["metrics"]
    assert "avg_cloud_pct" in metrics
    assert "max_wind_kmh" in metrics
    assert "expected_radiation_w_m2" in metrics