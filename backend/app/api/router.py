from fastapi import APIRouter

from backend.app.api.agent import router as agent_router
from backend.app.api.data import router as data_router
from backend.app.api.optimize import router as optimize_router
from backend.app.api.simulation import router as simulation_router
from backend.app.api.state import router as state_router

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(state_router)
api_router.include_router(optimize_router)
api_router.include_router(agent_router)
api_router.include_router(simulation_router)
api_router.include_router(data_router)
