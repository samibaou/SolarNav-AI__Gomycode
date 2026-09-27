from fastapi import APIRouter

from backend.app.dependencies import live_data
from backend.app.modules.data_twin.live.models import LiveData, LiveMode

router = APIRouter(tags=["data"])


@router.get("/data/live", response_model=LiveData)
def get_live_data(mode: LiveMode = "earth") -> LiveData:
    return live_data.snapshot(mode)
