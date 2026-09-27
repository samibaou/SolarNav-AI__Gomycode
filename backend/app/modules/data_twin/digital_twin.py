from __future__ import annotations

from datetime import timedelta

from backend.app.core.contracts import BatteryState, EnergyState, PanelState, TwinState


class DigitalTwin:
    """Mutable simulation facade around an immutable TwinState contract."""

    def __init__(self, initial_state: TwinState):
        self._state = initial_state

    @property
    def state(self) -> TwinState:
        return self._state

    def move_panel(self, tilt_deg: float, azimuth_deg: float) -> TwinState:
        panel = PanelState(
            tilt_deg=max(0.0, min(90.0, float(tilt_deg))),
            azimuth_deg=float(azimuth_deg) % 360.0,
        )
        self._state = self._state.model_copy(update={"panel": panel})
        return self._state

    def apply_energy_delta(self, energy_delta_wh: float, battery_capacity_wh: float) -> TwinState:
        if battery_capacity_wh <= 0:
            raise ValueError("battery_capacity_wh must be > 0")

        delta_pct = energy_delta_wh / battery_capacity_wh * 100.0
        new_soc = max(0.0, min(100.0, self._state.battery.soc_pct + delta_pct))
        self._state = self._state.model_copy(update={"battery": BatteryState(soc_pct=new_soc)})
        return self._state

    def set_observed_power(self, power_w: float) -> TwinState:
        self._state = self._state.model_copy(
            update={"energy": EnergyState(observed_power_w=max(0.0, power_w))}
        )
        return self._state

    def advance_time(self, minutes: float) -> TwinState:
        if minutes <= 0:
            raise ValueError("minutes must be > 0")
        self._state = self._state.model_copy(
            update={"timestamp": self._state.timestamp + timedelta(minutes=float(minutes))}
        )
        return self._state
