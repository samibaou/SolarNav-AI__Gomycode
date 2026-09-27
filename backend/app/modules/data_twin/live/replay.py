"""NASA POWER hourly replay (LST), second fallback for Earth weather after the last known value."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend.app.modules.data_twin.live.solar import local_solar_hour

FILL_VALUE = -999.0


@dataclass(frozen=True)
class ReplayRecord:
    lst: datetime          # local solar time of the record (naive)
    ghi: float | None
    ghi_clear: float | None
    temp_c: float | None
    wind_m_s: float | None


@dataclass(frozen=True)
class ReplayWeather:
    ghi_w_m2: float
    ghi_clear_w_m2: float | None
    ambient_c: float
    wind_m_s: float
    observed_at: datetime  # UTC instant of the replayed record


class NasaPowerReplay:
    """Replays a NASA POWER hourly file at the current local solar hour, cycling over its days."""

    def __init__(self, records: list[ReplayRecord], lon_deg: float, label: str):
        if not records:
            raise ValueError("empty NASA POWER replay")
        self.records = records
        self.lon_deg = lon_deg
        self.label = label

    @classmethod
    def load(cls, path: Path) -> "NasaPowerReplay":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("header", {}).get("time_standard", "LST") != "LST":
            raise ValueError("NASA POWER replay must use time-standard=LST")
        params = payload["properties"]["parameter"]
        wind = params.get("WS10M") or params["WS2M"]
        clear = params.get("CLRSKY_SFC_SW_DWN", {})

        def num(series: dict, key: str) -> float | None:
            value = series.get(key)
            return None if value is None or float(value) <= FILL_VALUE + 1e-6 else float(value)

        records = [
            ReplayRecord(
                lst=datetime.strptime(key, "%Y%m%d%H"),
                ghi=num(params["ALLSKY_SFC_SW_DWN"], key),
                ghi_clear=num(clear, key),
                temp_c=num(params["T2M"], key),
                wind_m_s=num(wind, key),
            )
            for key in sorted(params["ALLSKY_SFC_SW_DWN"])
        ]
        lon = float(payload.get("geometry", {}).get("coordinates", [0.0])[0])
        first, last = records[0].lst, records[-1].lst
        return cls(records, lon, f"NASA POWER (replay {first:%d/%m}–{last:%d/%m/%Y})")

    def at(self, now: datetime) -> ReplayWeather:
        """Record for today's local solar hour, on day (day-of-year mod file length) of the file."""
        hours = len(self.records)
        days = max(1, math.ceil(hours / 24))
        day_index = (now.timetuple().tm_yday - 1) % days
        t = day_index * 24 + local_solar_hour(now, self.lon_deg)
        i0 = int(t) % hours
        i1, frac = (i0 + 1) % hours, t - int(t)

        def lerp(field: str, default: float | None) -> float | None:
            a, b = getattr(self.records[i0], field), getattr(self.records[i1], field)
            if a is None or b is None:
                return a if a is not None else b if b is not None else default
            return a + (b - a) * frac

        lower = self.records[i0].lst
        upper = self.records[i1].lst
        if upper <= lower:
            upper += timedelta(hours=hours)
        observed_lst = lower + (upper - lower) * frac
        observed = (observed_lst - timedelta(hours=self.lon_deg / 15.0)).replace(tzinfo=timezone.utc)
        return ReplayWeather(
            ghi_w_m2=max(0.0, lerp("ghi", 0.0)),
            ghi_clear_w_m2=lerp("ghi_clear", None),
            ambient_c=lerp("temp_c", 20.0),
            wind_m_s=max(0.0, lerp("wind_m_s", 0.0)),
            observed_at=observed,
        )
