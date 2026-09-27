from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class RawInput(FrozenModel):
    timestamp: datetime
    sun_azimuth_deg: float
    sun_elevation_deg: float = Field(ge=-90.0, le=90.0)
    panel_azimuth_deg: float
    panel_tilt_deg: float = Field(ge=0.0, le=90.0)
    battery_soc_pct: float = Field(ge=0.0, le=100.0)
    illumination: float = Field(ge=0.0, le=1.0)
    shadow_probability: float = Field(ge=0.0, le=1.0)
    dust_factor: float = Field(ge=0.0, le=1.0)
    observed_power_w: float | None = Field(default=None, ge=0.0)


class SunState(FrozenModel):
    azimuth_deg: float = Field(ge=0.0, lt=360.0)
    elevation_deg: float = Field(ge=-90.0, le=90.0)


class PanelState(FrozenModel):
    tilt_deg: float = Field(ge=0.0, le=90.0)
    azimuth_deg: float = Field(ge=0.0, lt=360.0)


class BatteryState(FrozenModel):
    soc_pct: float = Field(ge=0.0, le=100.0)


class EnvironmentState(FrozenModel):
    illumination: float = Field(ge=0.0, le=1.0)
    shadow_probability: float = Field(ge=0.0, le=1.0)
    dust_factor: float = Field(ge=0.0, le=1.0)


class EnergyState(FrozenModel):
    observed_power_w: float | None = Field(default=None, ge=0.0)


class TwinState(FrozenModel):
    timestamp: datetime
    sun: SunState
    panel: PanelState
    battery: BatteryState
    environment: EnvironmentState
    energy: EnergyState


class PhysicsResult(FrozenModel):
    expected_power_w: float = Field(ge=0.0)
    incidence_angle_deg: float = Field(ge=0.0, le=180.0)
    effective_illumination: float = Field(ge=0.0, le=1.0)


class MLResult(FrozenModel):
    predicted_power_w: float = Field(ge=0.0)
    model_name: str
    confidence: float = Field(ge=0.0, le=1.0)


class DiagnosticResult(FrozenModel):
    status: Literal["OK", "ANOMALY", "NO_DATA"]
    performance_gap_pct: float
    message: str


class AnalysisBundle(FrozenModel):
    physics: PhysicsResult
    ml: MLResult
    diagnostic: DiagnosticResult


class CandidateAction(FrozenModel):
    tilt_deg: float = Field(ge=0.0, le=90.0)
    azimuth_deg: float = Field(ge=0.0, lt=360.0)
    predicted_power_w: float = Field(ge=0.0)
    solar_energy_wh: float = Field(ge=0.0)
    motor_cost_wh: float = Field(ge=0.0)
    net_energy_wh: float


class OptimizationResult(FrozenModel):
    horizon_minutes: float = Field(gt=0.0)
    current: CandidateAction
    best: CandidateAction
    net_gain_wh: float


class Decision(FrozenModel):
    action: Literal["MOVE", "HOLD"]
    target_tilt_deg: float = Field(ge=0.0, le=90.0)
    target_azimuth_deg: float = Field(ge=0.0, lt=360.0)
    reason: str
    explanation_source: Literal["template", "nvidia_nim", "fallback"]


class CycleResult(FrozenModel):
    initial_state: TwinState
    analysis: AnalysisBundle
    optimization: OptimizationResult
    decision: Decision
    updated_state: TwinState
    post_move_power_w: float = Field(ge=0.0)


class SimulationStepRequest(FrozenModel):
    step_minutes: float | None = Field(default=None, gt=0.0, le=180.0)
