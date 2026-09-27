"""Récupère la position réelle d'un satellite via l'API REST N2YO."""

import json
import os
import time

import requests

from backend.app.core.config import settings

N2YO_API_KEY = os.getenv("N2YO_API_KEY")
N2YO_BASE_URL = "https://api.n2yo.com/rest/v1/satellite"
N2YO_TIMEOUT = 30  # secondes : N2YO met parfois plus de 10 s à répondre
TLE_CACHE_PATH = settings.root_dir / "data" / "cache" / "tle_cache.json"
POSITION_CACHE_SECONDS = 10  # une position plus récente que ça est réutilisée sans appel API

_position_cache: dict[int, tuple[float, tuple[float, float, float]]] = {}

# Observateur par défaut (requis par l'endpoint /positions, sans effet sur lat/lon/alt du satellite)
OBSERVER_LAT = 45.5017
OBSERVER_LON = -73.5673
OBSERVER_ALT = 0


def _n2yo_get(path: str) -> dict:
    """Appelle l'endpoint N2YO {N2YO_BASE_URL}/{path} et renvoie le JSON."""
    if not N2YO_API_KEY:
        raise RuntimeError("N2YO_API_KEY manquant : copier .env.example vers .env et renseigner la clé.")

    response = requests.get(f"{N2YO_BASE_URL}/{path}", params={"apiKey": N2YO_API_KEY}, timeout=N2YO_TIMEOUT)
    response.raise_for_status()
    payload = response.json()

    # N2YO renvoie un 200 avec {"error": "..."} si la clé ou l'ID est invalide
    if "error" in payload:
        raise RuntimeError(f"Erreur N2YO sur {path} : {payload['error']}")
    return payload


def get_sat_position(norad_id: int) -> tuple[float, float, float]:
    """Retourne (sat_lat, sat_lon, sat_alt) du satellite identifié par norad_id.

    sat_lat, sat_lon en degrés, sat_alt en km.

    Économise le quota N2YO (~1000 requêtes/heure en gratuit) : une position de moins de
    POSITION_CACHE_SECONDS est réutilisée. Si N2YO est injoignable, la position est
    calculée à partir de l'orbite (TLE en cache) avec Skyfield.
    """
    cached = _position_cache.get(norad_id)
    if cached and time.monotonic() - cached[0] < POSITION_CACHE_SECONDS:
        return cached[1]

    try:
        payload = _n2yo_get(f"positions/{norad_id}/{OBSERVER_LAT}/{OBSERVER_LON}/{OBSERVER_ALT}/1/")
        if not payload.get("positions"):
            raise RuntimeError(f"Aucune position N2YO pour NORAD {norad_id} : {payload}")
        position = payload["positions"][0]
        result = (position["satlatitude"], position["satlongitude"], position["sataltitude"])
    except (requests.RequestException, RuntimeError) as exc:
        print(f"N2YO injoignable ({exc}), position calculée depuis l'orbite en cache.")
        result = _position_from_tle(norad_id)

    _position_cache[norad_id] = (time.monotonic(), result)
    return result


def _position_from_tle(norad_id: int) -> tuple[float, float, float]:
    """Position actuelle calculée par Skyfield à partir du TLE (cache local si N2YO est hors ligne)."""
    from backend.app.modules.data_twin.sun import get_orbit_sun_angles

    row = get_orbit_sun_angles(get_sat_tle(norad_id), n_points=1).iloc[0]
    return float(row.sat_lat), float(row.sat_lon), float(row.sat_alt)


def _load_tle_cache() -> dict:
    try:
        return json.loads(TLE_CACHE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def get_sat_tle(norad_id: int) -> tuple[str, str, str]:
    """Retourne (nom, ligne1, ligne2) du TLE du satellite, pour propager son orbite avec Skyfield.

    Chaque TLE reçu est mis en cache (data/cache/tle_cache.json). Si N2YO est injoignable,
    on réutilise le dernier TLE connu : il reste précis quelques jours.
    """
    cache = _load_tle_cache()
    try:
        payload = _n2yo_get(f"tle/{norad_id}")
        lines = payload.get("tle", "").splitlines()
        if len(lines) != 2:
            raise RuntimeError(f"TLE N2YO invalide pour NORAD {norad_id} : {payload}")
        tle = [payload["info"]["satname"], lines[0].strip(), lines[1].strip()]
    except (requests.RequestException, RuntimeError):
        if str(norad_id) not in cache:
            raise
        print(f"N2YO injoignable, TLE en cache utilisé pour NORAD {norad_id}.")
        return tuple(cache[str(norad_id)])

    cache[str(norad_id)] = tle
    TLE_CACHE_PATH.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    return tuple(tle)


if __name__ == "__main__":
    # 25544 = ISS
    print(get_sat_position(25544))
    print(get_sat_tle(25544))
