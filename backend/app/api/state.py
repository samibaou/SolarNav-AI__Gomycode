from fastapi import APIRouter

from backend.app.core.contracts import RawInput, TwinState
from backend.app.dependencies import store
from backend.app.modules.data_twin.pipeline import build_twin_state

router = APIRouter(tags=["state"])


@router.get("/state", response_model=TwinState)
def get_state() -> TwinState:
    return store.get()


@router.post("/state/reset", response_model=TwinState)
def reset_state(raw: RawInput) -> TwinState:
    return store.replace(build_twin_state(raw))
