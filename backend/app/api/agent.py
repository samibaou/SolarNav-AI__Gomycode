from fastapi import APIRouter

from backend.app.core.contracts import Decision
from backend.app.dependencies import orchestrator

router = APIRouter(tags=["agent"])


@router.post("/agent/decision", response_model=Decision)
def agent_decision() -> Decision:
    return orchestrator.recommend()
