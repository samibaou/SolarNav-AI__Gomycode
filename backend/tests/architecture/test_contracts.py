from backend.app.core.contracts import RawInput


def test_public_state_contract_keys_are_stable(twin_state):
    assert set(twin_state.model_dump()) == {"timestamp", "sun", "panel", "battery", "environment", "energy"}


def test_raw_input_forbids_unknown_fields(raw_input):
    payload = raw_input.model_dump()
    payload["unexpected"] = 123
    try:
        RawInput.model_validate(payload)
    except Exception:
        pass
    else:
        raise AssertionError("RawInput unexpectedly accepted an unknown field")
