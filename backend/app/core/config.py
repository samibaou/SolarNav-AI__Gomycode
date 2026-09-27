from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[3]
load_dotenv(ROOT_DIR / ".env")


def _float(name: str, default: float) -> float:
    raw = os.getenv(name)
    return default if raw in (None, "") else float(raw)


def _origins() -> tuple[str, ...]:
    raw = os.getenv(
        "SOLARNAV_CORS_ORIGINS",
        "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000",
    )
    return tuple(x.strip() for x in raw.split(",") if x.strip())


@dataclass(frozen=True)
class Settings:
    root_dir: Path = ROOT_DIR
    data_file: Path = ROOT_DIR / "data" / "sample_input.json"
    model_file: Path = ROOT_DIR / "models" / "power_model.joblib"
    frontend_dir: Path = ROOT_DIR / "frontend"

    panel_max_power_w: float = _float("SOLARNAV_PANEL_MAX_POWER_W", 1000.0)
    battery_capacity_wh: float = _float("SOLARNAV_BATTERY_CAPACITY_WH", 5000.0)
    base_load_w: float = _float("SOLARNAV_BASE_LOAD_W", 250.0)
    motor_cost_wh_per_deg: float = _float("SOLARNAV_MOTOR_COST_WH_PER_DEG", 0.02)
    optimization_horizon_min: float = _float("SOLARNAV_OPTIMIZATION_HORIZON_MIN", 30.0)
    simulation_step_min: float = _float("SOLARNAV_SIMULATION_STEP_MIN", 5.0)
    min_move_gain_wh: float = _float("SOLARNAV_MIN_MOVE_GAIN_WH", 2.0)

    cors_origins: tuple[str, ...] = _origins()

    nim_base_url: str = os.getenv("NIM_BASE_URL", "").strip()
    nim_api_key: str = os.getenv("NIM_API_KEY", "").strip()
    nim_model: str = os.getenv("NIM_MODEL", "").strip()
    nim_timeout_seconds: float = _float("NIM_TIMEOUT_SECONDS", 8.0)

    @property
    def nim_enabled(self) -> bool:
        return bool(self.nim_base_url and self.nim_api_key and self.nim_model)


settings = Settings()
