"""Formule physique de l'angle optimal du panneau (cible du modèle IA d'angle).

Puissance relative d'un panneau 1 axe selon l'élévation du soleil, la poussière
et la température, et angle d'inclinaison qui la maximise.
"""

import numpy as np

# Angle d'inclinaison du panneau : 0° = à plat (face au zénith), 90° = vertical
MAX_TILT = 90.0  # butée mécanique du panneau
# L'optimum est cherché jusqu'à 180° puis ramené en butée : si le panneau devrait
# dépasser la verticale, il reste à 90° au lieu de basculer brusquement de l'autre côté.
TILT_GRID = np.linspace(0, 180, 361)  # pas de 0.5°
STOW_ANGLE = 0.0  # position de repli quand le satellite est dans l'ombre

TEMP_COEFF = 0.004  # perte de rendement par °C au-dessus de 25 °C (cellules silicium)
SUN_HEATING = 30.0  # échauffement du panneau (°C) sous éclairement direct
OVERHEAT_TEMP = 100.0  # au-delà, le rendement chute plus vite (surchauffe)
OVERHEAT_COEFF = 0.005
MIN_USEFUL_POWER = 0.01  # en dessous, le panneau ne produit quasiment rien
DUST_LOSS = 0.2  # perte max de transmission due à la poussière (panneau à plat, 100 %)


def panel_power(tilt, sun_elevation, dust_level, surface_temp):
    """Puissance relative (0-1) d'un panneau incliné de `tilt` degrés.

    Puissance = éclairement × transmission × rendement thermique, avec :
    - éclairement = cos(angle d'incidence), incidence = |tilt - (90 - élévation)|
    - transmission : la poussière couvre plus un panneau à plat qu'incliné
    - rendement thermique : plus le panneau reçoit de soleil, plus il chauffe,
      et au-delà de OVERHEAT_TEMP il vaut mieux dépointer légèrement

    Les arguments sont diffusés numpy (broadcasting) : scalaires ou tableaux.
    """
    tilt = np.asarray(tilt, dtype=float)
    irradiance = np.clip(np.cos(np.radians(np.abs(tilt - (90.0 - sun_elevation)))), 0.0, None)
    transmission = 1.0 - DUST_LOSS * (dust_level / 100.0) * np.clip(np.cos(np.radians(tilt)), 0.0, None)

    panel_temp = surface_temp + SUN_HEATING * irradiance
    efficiency = (
        1.0
        - TEMP_COEFF * (panel_temp - 25.0)
        - OVERHEAT_COEFF * np.clip(panel_temp - OVERHEAT_TEMP, 0.0, None)
    )
    # Un panneau en surchauffe ne produit plus rien, mais jamais d'énergie négative
    return irradiance * transmission * np.clip(efficiency, 0.0, None)


def compute_optimal_angle(sun_elevation, is_sunlit, dust_level, surface_temp):
    """Angle d'inclinaison (°) qui maximise panel_power, STOW_ANGLE à l'ombre.

    Accepte des scalaires ou des tableaux numpy (calcul vectorisé).
    """
    sun_elevation = np.atleast_1d(np.asarray(sun_elevation, dtype=float))[:, None]
    is_sunlit = np.atleast_1d(np.asarray(is_sunlit, dtype=bool))
    dust_level = np.atleast_1d(np.asarray(dust_level, dtype=float))[:, None]
    surface_temp = np.atleast_1d(np.asarray(surface_temp, dtype=float))[:, None]

    power = panel_power(TILT_GRID[None, :], sun_elevation, dust_level, surface_temp)
    # Le dépointage thermique est symétrique (tilt ± x donnent la même puissance) :
    # à égalité on prend le plus incliné, dans le même sens que la poussière,
    # sinon la cible sauterait d'un côté à l'autre pour des entrées quasi identiques.
    optimal = np.minimum(TILT_GRID[::-1][np.argmax(power[:, ::-1], axis=1)], MAX_TILT)
    return np.where(is_sunlit, optimal, STOW_ANGLE)


def energy_ratio(predicted_tilt, sun_elevation, dust_level, surface_temp):
    """Part (0-1) de l'énergie maximale obtenue avec l'angle prédit (scénarios au soleil).

    Vaut 1 quand même l'angle parfait ne produit quasiment rien : rien à perdre.
    """
    best_tilt = compute_optimal_angle(sun_elevation, np.ones_like(sun_elevation), dust_level, surface_temp)
    best = panel_power(best_tilt, sun_elevation, dust_level, surface_temp)
    got = panel_power(np.clip(predicted_tilt, 0, MAX_TILT), sun_elevation, dust_level, surface_temp)
    ratio = np.clip(got / np.maximum(best, 1e-9), 0.0, 1.0)
    return np.where(best < MIN_USEFUL_POWER, 1.0, ratio)


def simulate_surface_temp(sun_elevation, is_sunlit, rng=None):
    """Température de surface (°C) : chauffe avec la hauteur du soleil, très froide à l'ombre.

    Sans rng, renvoie la valeur moyenne (sans bruit) : utile pour le dashboard en direct.
    """
    sun_elevation = np.asarray(sun_elevation, dtype=float)
    is_sunlit = np.asarray(is_sunlit, dtype=bool)
    sun_factor = np.sin(np.radians(np.clip(sun_elevation, 0, 90)))
    lit_noise = rng.normal(0, 25, sun_elevation.shape) if rng is not None else 0.0
    shadow_noise = rng.normal(0, 15, sun_elevation.shape) if rng is not None else 0.0
    return np.where(is_sunlit, -20 + 140 * sun_factor + lit_noise, -120 + shadow_noise)
