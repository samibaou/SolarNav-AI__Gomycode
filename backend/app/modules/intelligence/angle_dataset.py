"""Génère un dataset d'entraînement simulé pour le modèle d'angle optimal.

Une ligne = un scénario (géométrie soleil réelle, poussière et température simulées) :
sun_elevation | sun_azimuth | is_sunlit | dust_level | surface_temp || angle_optimal
"""

import numpy as np
import pandas as pd

from backend.app.core.config import settings
from backend.app.modules.intelligence.angle_physics import compute_optimal_angle, simulate_surface_temp

DATASET_PATH = settings.root_dir / "data" / "processed" / "angle_training_data.csv"

# Géométrie aléatoire : dans l'ombre quand le soleil passe sous l'horizon apparent,
# abaissé de acos(R / (R + h)) en orbite : ~20° pour l'ISS, ~81° en orbite géostationnaire,
# 0° au sol (base lunaire).
EARTH_RADIUS_KM = 6371.0
MIN_ALT_KM, MAX_ALT_KM = 200.0, 36_000.0  # de l'orbite basse à la géostationnaire
SURFACE_FRACTION = 0.25  # part des scénarios aléatoires posés au sol (base lunaire)
HIGH_SUN_FRACTION = 0.3
HIGH_SUN_MIN_ELEVATION = 60.0
TEMP_RANGE = (-150.0, 160.0)  # températures de surface possibles au soleil

# Satellites dont l'orbite réelle sert de base au dataset :
# ISS, Hubble, NOAA-19 (héliosynchrone, éclairage très différent)
DEFAULT_NORAD_IDS = (25544, 20580, 33591)
# Sur ces orbites le soleil ne dépasse jamais ~67° d'élévation. Un Random Forest
# n'extrapole pas : on ajoute une part de scénarios aléatoires couvrant tout le ciel
# (soleil au zénith, base lunaire...).
RANDOM_FRACTION = 0.4


def _random_geometry(n_samples, rng):
    """Scénarios aléatoires couvrant tout l'espace des situations possibles.

    Altitude tirée de l'orbite basse à la géostationnaire (ou au sol pour une base
    lunaire), soleil n'importe où dans le ciel, et température au soleil indépendante
    de l'élévation (sortie d'éclipse, radiateur, sol lunaire...).
    """
    sun_elevation = rng.uniform(-90, 90, n_samples)
    # Soleil haut sur-représenté : jamais atteint sur les orbites réelles, et c'est là
    # que poussière et chaleur (panneau presque à plat) changent le plus l'angle optimal
    high_sun = rng.random(n_samples) < HIGH_SUN_FRACTION
    sun_elevation[high_sun] = rng.uniform(HIGH_SUN_MIN_ELEVATION, 90, high_sun.sum())
    altitude = np.exp(rng.uniform(np.log(MIN_ALT_KM), np.log(MAX_ALT_KM), n_samples))
    horizon_dip = np.degrees(np.arccos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitude)))
    horizon_dip[rng.random(n_samples) < SURFACE_FRACTION] = 0.0
    is_sunlit = sun_elevation > -horizon_dip

    shadow_temp = simulate_surface_temp(sun_elevation, np.zeros(n_samples, dtype=bool), rng)
    lit_temp = rng.uniform(*TEMP_RANGE, n_samples)
    return pd.DataFrame({
        "sun_elevation": sun_elevation,
        "sun_azimuth": rng.uniform(0, 360, n_samples),
        "is_sunlit": is_sunlit,
        "surface_temp": np.where(is_sunlit, lit_temp, shadow_temp),
    })


def _orbit_geometry(n_samples, norad_ids):
    """Géométrie soleil réelle : orbites (TLE N2YO) propagées avec Skyfield, 1 point / minute."""
    from backend.app.modules.data_twin.satellite import get_sat_tle
    from backend.app.modules.data_twin.sun import get_orbit_sun_angles

    per_sat = -(-n_samples // len(norad_ids))  # division arrondie au supérieur
    frames = [get_orbit_sun_angles(get_sat_tle(nid), n_points=per_sat) for nid in norad_ids]
    return pd.concat(frames, ignore_index=True).head(n_samples)


def generate_dataset(
    n_samples: int = 40_000,
    seed: int = 42,
    norad_ids: tuple[int, ...] = DEFAULT_NORAD_IDS,
    use_real_orbits: bool = True,
) -> pd.DataFrame:
    """Génère n_samples scénarios.

    - sun_elevation, sun_azimuth, is_sunlit : réels (orbites N2YO + Skyfield) complétés
      de RANDOM_FRACTION de tirages aléatoires ; 100 % aléatoires si use_real_orbits=False
      ou si l'API échoue
    - dust_level, surface_temp : simulés
    - angle_optimal : formule physique + bruit
    """
    rng = np.random.default_rng(seed)

    geometry = None
    if use_real_orbits:
        n_orbit = round(n_samples * (1 - RANDOM_FRACTION))
        try:
            orbit = _orbit_geometry(n_orbit, norad_ids)
            geometry = pd.concat(
                [orbit, _random_geometry(n_samples - n_orbit, rng)], ignore_index=True
            )
        except Exception as exc:  # réseau, quota N2YO, clé absente...
            print(f"Orbites réelles indisponibles ({exc}), repli sur une géométrie aléatoire.")
    if geometry is None:
        geometry = _random_geometry(n_samples, rng)

    sun_elevation = geometry["sun_elevation"].to_numpy()
    sun_azimuth = geometry["sun_azimuth"].to_numpy()
    is_sunlit = geometry["is_sunlit"].to_numpy(dtype=bool)
    dust_level = rng.uniform(0, 100, len(geometry))
    # Orbites réelles : température liée au soleil ; scénarios aléatoires : déjà tirée
    surface_temp = simulate_surface_temp(sun_elevation, is_sunlit, rng)
    if "surface_temp" in geometry:
        given = geometry["surface_temp"].to_numpy()
        surface_temp = np.where(np.isnan(given), surface_temp, given)

    angle_optimal = compute_optimal_angle(sun_elevation, is_sunlit, dust_level, surface_temp)
    # Bruit de mesure / d'actionneur sur la cible, sans sortir de [0, 90]
    angle_optimal = np.clip(angle_optimal + rng.normal(0, 0.5, len(geometry)), 0, 90)

    return pd.DataFrame({
        "sun_elevation": sun_elevation.round(2),
        "sun_azimuth": sun_azimuth.round(2),
        "is_sunlit": is_sunlit.astype(int),
        "dust_level": dust_level.round(1),
        "surface_temp": surface_temp.round(1),
        "angle_optimal": angle_optimal.round(1),
    })
