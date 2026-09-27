from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.contracts import RawInput
from backend.app.main import app
from backend.app.modules.data_twin.pipeline import build_twin_state


@pytest.fixture
def test_settings(tmp_path):
    return Settings(
        root_dir=tmp_path,
        data_file=tmp_path / "sample_input.json",
        model_file=tmp_path / "missing.joblib",
        frontend_dir=tmp_path / "frontend",
        panel_max_power_w=1000.0,
        battery_capacity_wh=5000.0,
        base_load_w=250.0,
        motor_cost_wh_per_deg=0.02,
        optimization_horizon_min=30.0,
        simulation_step_min=5.0,
        min_move_gain_wh=2.0,
        cors_origins=("http://localhost:8000",),
        nim_base_url="",
        nim_api_key="",
        nim_model="",
        nim_timeout_seconds=1.0,
    )


@pytest.fixture
def raw_input():
    return RawInput(
        timestamp=datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc),
        sun_azimuth_deg=142.0,
        sun_elevation_deg=4.8,
        panel_azimuth_deg=120.0,
        panel_tilt_deg=32.0,
        battery_soc_pct=41.0,
        illumination=0.88,
        shadow_probability=0.15,
        dust_factor=0.95,
        observed_power_w=400.0,
    )


@pytest.fixture
def twin_state(raw_input):
    return build_twin_state(raw_input)


@pytest.fixture
def client():
    return TestClient(app)
