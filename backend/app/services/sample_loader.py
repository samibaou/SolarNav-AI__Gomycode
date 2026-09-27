import json
from pathlib import Path

from backend.app.core.contracts import RawInput


def load_raw_input(path: Path) -> RawInput:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return RawInput.model_validate(payload)
