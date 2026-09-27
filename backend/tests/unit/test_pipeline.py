import pytest
from pydantic import ValidationError

from backend.app.core.contracts import RawInput
from backend.app.modules.data_twin.pipeline import build_twin_state


def test_pipeline_normalizes_azimuth(raw_input):
    raw = raw_input.model_copy(update={"sun_azimuth_deg": 400.0, "panel_azimuth_deg": -10.0})
    state = build_twin_state(raw)
    assert state.sun.azimuth_deg == pytest.approx(40.0)
    assert state.panel.azimuth_deg == pytest.approx(350.0)


@pytest.mark.parametrize(
    "field,value",
    [
        ("panel_tilt_deg", 91),
        ("battery_soc_pct", 101),
        ("illumination", 1.1),
        ("shadow_probability", -0.1),
        ("dust_factor", 1.1),
        ("observed_power_w", -1),
    ],
)
def test_contract_rejects_impossible_ranges(raw_input, field, value):
    payload = raw_input.model_dump()
    payload[field] = value
    with pytest.raises(ValidationError):
        RawInput.model_validate(payload)
