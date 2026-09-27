from fastapi import APIRouter

from backend.app.api.agent import router as agent_router
from backend.app.api.data import router as data_router
from backend.app.api.optimize import router as optimize_router
from backend.app.api.simulation import router as simulation_router
from backend.app.api.state import router as state_router
from backend.app.core.contracts import WeatherStrategyResponse
from backend.app.services.weather_forecaster import WeatherForecasterService

# Routeur principal avec le préfixe /api/v1
api_router = APIRouter(prefix="/api/v1")

# Inclusion des sous-routeurs existants du projet
api_router.include_router(state_router)
api_router.include_router(optimize_router)
api_router.include_router(agent_router)
api_router.include_router(simulation_router)
api_router.include_router(data_router)

# Définition du sous-routeur Météo
weather_router = APIRouter(prefix="/weather", tags=["Weather Forecast"])


@weather_router.get("/forecast", response_model=WeatherStrategyResponse)
def get_weather_forecast(lat: float = 33.5731, lon: float = -7.5898):
    """
    Renvoie la stratégie et les prévisions météo pour les panneaux solaires.
    Par défaut : Casablanca, Maroc (33.5731, -7.5898).
    """
    service = WeatherForecasterService(lat=lat, lon=lon)
    return service.get_tomorrow_strategy()


# Montage du sous-routeur météo dans le routeur principal
api_router.include_router(weather_router)
