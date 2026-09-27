from fastapi import APIRouter

from backend.app.core.contracts import AnalysisBundle, OptimizationResult
from backend.app.dependencies import orchestrator

router = APIRouter(tags=["optimization"])


@router.post("/optimize", response_model=OptimizationResult)
def optimize_current() -> OptimizationResult:
    return orchestrator.optimize_current()


@router.get("/analysis", response_model=AnalysisBundle)
def analysis() -> AnalysisBundle:
    return orchestrator.analyze()
