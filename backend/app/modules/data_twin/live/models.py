"""Response format of GET /api/v1/data/live.

Same conventions as backend/app/core/contracts.py: snake_case, irradiance in W/m²,
compass azimuth (0 = North, 90 = East) in [0, 360), elevation in degrees above the horizon.
Kept in P1's module until the team agrees to promote it into the shared contracts.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from backend.app.core.contracts import FrozenModel

LiveMode = Literal["earth", "moon"]
# live: fresh value from the API; cache: API failed, last known value; fallback: replay or simulation.
SourceStatus = Literal["live", "cache", "fallback"]
SpaceWeatherLevel = Literal["none", "moderate", "strong", "unknown"]


class SourceMeta(FrozenModel):
    id: str
    label: str
    status: SourceStatus
    updated_at: datetime
    observed_at: datetime | None = None
    age_s: float = Field(ge=0.0)
    error: str | None = None


class LiveSite(FrozenModel):
    name: str
    body: Literal["earth", "moon"]
    lat_deg: float = Field(ge=-90.0, le=90.0)
    lon_deg: float


class LiveSun(FrozenModel):
    azimuth_deg: float = Field(ge=0.0, lt=360.0)
    elevation_deg: float = Field(ge=-90.0, le=90.0)
    source: SourceMeta


class LiveWeather(FrozenModel):
    ghi_w_m2: float = Field(ge=0.0)
    dni_w_m2: float = Field(ge=0.0)
    dhi_w_m2: float = Field(ge=0.0)
    ghi_clear_w_m2: float | None = Field(default=None, ge=0.0)
    albedo: float = Field(ge=0.0, le=1.0)
    ambient_c: float | None = None
    wind_m_s: float | None = Field(default=None, ge=0.0)
    cloud_factor: float | None = Field(default=None, ge=0.0, le=1.0)
    source: SourceMeta


class SpaceWeather(FrozenModel):
    level: SpaceWeatherLevel
    risk_flags: tuple[str, ...]
    recommended_action: Literal["STOW"] | None
    # auto: the deterministic policy applies STOW; operator: STOW waits for a human validation.
    validation_gate: Literal["auto", "operator"]
    reasons: tuple[str, ...]
    xray_flux_w_m2: float | None = None
    xray_class: str | None = None
    solar_wind_speed_km_s: float | None = None
    solar_wind_density_cm3: float | None = None
    imf_bz_nt: float | None = None
    max_kp_24h: float | None = None
    flares_24h: tuple[str, ...] = ()
    sources: tuple[SourceMeta, ...]


class LiveData(FrozenModel):
    schema_version: Literal["1.0"] = "1.0"
    mode: LiveMode
    generated_at: datetime
    site: LiveSite
    sun: LiveSun
    weather: LiveWeather
    space_weather: SpaceWeather
