import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import json

from backend.app.core.config import settings
from backend.app.modules.data_twin.pipeline import build_twin_state
from backend.app.modules.data_twin.store import DigitalTwinStore
from backend.app.orchestrator import SolarNavOrchestrator
from backend.app.services.sample_loader import load_raw_input

raw = load_raw_input(settings.data_file)
state = build_twin_state(raw)
store = DigitalTwinStore(state)
orchestrator = SolarNavOrchestrator(store=store, settings=settings)
result = orchestrator.run_cycle()
print(json.dumps(result.model_dump(mode="json"), indent=2))
