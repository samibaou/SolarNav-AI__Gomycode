from backend.app.core.config import settings
from backend.app.modules.data_twin.pipeline import build_twin_state
from backend.app.modules.data_twin.store import DigitalTwinStore
from backend.app.orchestrator import SolarNavOrchestrator
from backend.app.services.sample_loader import load_raw_input


_initial_raw = load_raw_input(settings.data_file)
_initial_state = build_twin_state(_initial_raw)
store = DigitalTwinStore(_initial_state)
orchestrator = SolarNavOrchestrator(store=store, settings=settings)
