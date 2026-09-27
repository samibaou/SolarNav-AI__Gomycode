from fastapi import APIRouter

from backend.app.core.contracts import CycleResult, SimulationStepRequest
from backend.app.dependencies import orchestrator

router = APIRouter(tags=["simulation"])


@router.post("/simulation/cycle", response_model=CycleResult)
def run_cycle(request: SimulationStepRequest | None = None) -> CycleResult:
    step = None if request is None else request.step_minutes
    return orchestrator.run_cycle(step_minutes=step)
