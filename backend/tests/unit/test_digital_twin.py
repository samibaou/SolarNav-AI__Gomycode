from datetime import timedelta

import pytest

from backend.app.modules.data_twin.digital_twin import DigitalTwin


def test_move_panel_updates_only_panel(twin_state):
    twin = DigitalTwin(twin_state)
    before = twin.state
    after = twin.move_panel(47, 141)
    assert after.panel.tilt_deg == 47
    assert after.panel.azimuth_deg == 141
    assert after.sun == before.sun
    assert after.battery == before.battery


def test_battery_energy_update_is_clamped(twin_state):
    twin = DigitalTwin(twin_state)
    twin.apply_energy_delta(999999, 5000)
    assert twin.state.battery.soc_pct == 100
    twin.apply_energy_delta(-999999, 5000)
    assert twin.state.battery.soc_pct == 0


def test_invalid_battery_capacity_is_rejected(twin_state):
    twin = DigitalTwin(twin_state)
    with pytest.raises(ValueError):
        twin.apply_energy_delta(10, 0)


def test_time_advances(twin_state):
    twin = DigitalTwin(twin_state)
    initial = twin.state.timestamp
    twin.advance_time(5)
    assert twin.state.timestamp == initial + timedelta(minutes=5)
