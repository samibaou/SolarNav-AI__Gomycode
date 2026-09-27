from backend.app.dependencies import store
from backend.app.modules.data_twin.pipeline import build_twin_state


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_state_contract(client):
    response = client.get("/api/v1/state")
    assert response.status_code == 200
    assert set(response.json()) == {"timestamp", "sun", "panel", "battery", "environment", "energy"}


def test_reset_rejects_invalid_battery(client, raw_input):
    payload = raw_input.model_dump(mode="json")
    payload["battery_soc_pct"] = 150
    assert client.post("/api/v1/state/reset", json=payload).status_code == 422


def test_reset_normalizes_azimuth(client, raw_input):
    payload = raw_input.model_dump(mode="json")
    payload["sun_azimuth_deg"] = 400
    response = client.post("/api/v1/state/reset", json=payload)
    assert response.status_code == 200
    assert response.json()["sun"]["azimuth_deg"] == 40


def test_optimize_endpoint_does_not_mutate_state(client, raw_input):
    store.replace(build_twin_state(raw_input))
    before = client.get("/api/v1/state").json()
    response = client.post("/api/v1/optimize")
    assert response.status_code == 200
    assert client.get("/api/v1/state").json() == before


def test_cycle_endpoint_updates_state(client, raw_input):
    store.replace(build_twin_state(raw_input))
    before = client.get("/api/v1/state").json()
    response = client.post("/api/v1/simulation/cycle", json={"step_minutes": 5})
    assert response.status_code == 200
    result = response.json()
    after = client.get("/api/v1/state").json()
    assert result["updated_state"] == after
    assert after["timestamp"] != before["timestamp"]


def test_agent_endpoint_returns_valid_action(client, raw_input):
    store.replace(build_twin_state(raw_input))
    response = client.post("/api/v1/agent/decision")
    assert response.status_code == 200
    assert response.json()["action"] in {"MOVE", "HOLD"}


def test_cycle_rejects_invalid_step(client):
    response = client.post("/api/v1/simulation/cycle", json={"step_minutes": -1})
    assert response.status_code == 422


def test_frontend_root_and_static_css_are_served(client):
    root = client.get("/")
    assert root.status_code == 200
    assert "SolarNav AI" in root.text

    css = client.get("/css/style.css")
    assert css.status_code == 200
    assert "twin-stage" in css.text
