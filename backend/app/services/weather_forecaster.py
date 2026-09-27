import requests
import pandas as pd
from backend.app.core.contracts import WeatherStrategyResponse, WeatherForecastMetrics

class WeatherForecasterService:
    def __init__(self, lat: float = 33.5731, lon: float = -7.5898):
        """
        Coordonnées par défaut : Casablanca, Maroc (33.5731, -7.5898).
        Modifiable dynamiquement si une autre position est fournie.
        """
        self.lat = lat
        self.lon = lon
        self.api_url = "https://api.open-meteo.com/v1/forecast"

    def get_tomorrow_strategy(self) -> WeatherStrategyResponse:
        params = {
            "latitude": self.lat,
            "longitude": self.lon,
            "hourly": ["cloud_cover", "direct_radiation", "precipitation", "wind_speed_10m"],
            "forecast_days": 2,
            "timezone": "auto" # S'adapte automatiquement au fuseau horaire de Casablanca (Africa/Casablanca)
        }
        
        try:
            res = requests.get(self.api_url, params=params, timeout=5)
            res.raise_for_status()
            df = pd.DataFrame(res.json()["hourly"])
            df["time"] = pd.to_datetime(df["time"], errors="coerce")
            if df["time"].isna().all():
                raise ValueError("Open-Meteo hourly timestamps unavailable")
            first_day = df["time"].dropna().min().normalize()
            tomorrow = first_day + pd.Timedelta(days=1)
            day_after = tomorrow + pd.Timedelta(days=1)
            df = df[(df["time"] >= tomorrow) & (df["time"] < day_after)]
            if df.empty:
                raise ValueError("Open-Meteo tomorrow slice unavailable")
            
            avg_cloud = float(df['cloud_cover'].mean())
            total_rain = float(df['precipitation'].sum())
            max_wind = float(df['wind_speed_10m'].max())
            avg_rad = float(df['direct_radiation'].mean())
        except Exception:
            return WeatherStrategyResponse(
                data_origin="unavailable",
                status="DONNÉES INDISPONIBLES",
                action_plan="Aucune stratégie météo calculée; l’état courant est conservé.",
                mode="UNAVAILABLE",
                color_code="#64748b",
                metrics=WeatherForecastMetrics(),
            )

        # Règle de décision stratégique
        if max_wind > 70:
            status, action, mode, color = "🚨 ALERTE TEMPÊTE", "Verrouillage sécurité (Panneaux à 0°).", "SAFETY_STOW", "#ef4444"
        elif total_rain > 10 or avg_cloud > 80:
            status, action, mode, color = "🌧️ COUVERT", "Lumière diffuse : Panneaux à plat à 0°.", "LOW_POWER", "#f59e0b"
        else:
            status, action, mode, color = "☀️ OPTIMAL", "Suivi dynamique de la trajectoire solaire.", "ACTIVE_TRACKING", "#10b981"

        return WeatherStrategyResponse(
            data_origin="live",
            status=status,
            action_plan=action,
            mode=mode,
            color_code=color,
            metrics=WeatherForecastMetrics(
                avg_cloud_pct=round(avg_cloud, 1),
                total_rain_mm=round(total_rain, 1),
                max_wind_kmh=round(max_wind, 1),
                expected_radiation_w_m2=round(avg_rad, 1)
            )
        )