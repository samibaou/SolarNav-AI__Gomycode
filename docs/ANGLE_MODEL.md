# Modèle IA d'angle optimal (P1 données + P2 intelligence)

Prédit l'angle optimal d'un panneau solaire spatial (satellite ou base lunaire)
par IA, à partir de la position réelle du soleil.

## Où se trouve quoi

| Rôle | Fichier |
|---|---|
| Position réelle d'un satellite et orbite (TLE) via l'API N2YO (P1) | `backend/app/modules/data_twin/satellite_source.py` |
| Élévation, azimut du soleil et éclairage avec Skyfield (P1) | `backend/app/modules/data_twin/ephemeris.py` |
| Formule physique : puissance du panneau, angle optimal, énergie récupérée | `backend/app/modules/intelligence/angle_physics.py` |
| Dataset de 40 000 scénarios (orbites ISS, Hubble, NOAA-19 + scénarios aléatoires : GEO, Lune, soleil au zénith) | `backend/app/modules/intelligence/angle_dataset.py` |
| Modèle hybride (formule physique + ExtraTrees qui apprend la correction) | `backend/app/modules/intelligence/angle_model.py` |
| Validation croisée, métriques, sauvegarde | `backend/app/modules/intelligence/angle_training.py` |
| Prédiction (avec incertitude) | `backend/app/modules/intelligence/angle_predictor.py` |
| Tests unitaires rapides (pytest) | `backend/tests/unit/test_angle_model.py` |

Fichiers générés / cache :

| Fichier | Contenu | Git |
|---|---|---|
| `data/tle_cache.json` | dernières orbites connues (mode hors ligne) | suivi |
| `data/ephemeris/` | éphémérides NASA/JPL (~19 Mo, téléchargées au 1er lancement) | ignoré |
| `data/processed/angle_training_data.csv` | dataset d'entraînement | ignoré |
| `models/angle_model.joblib` | modèle entraîné | ignoré |

## Lancement

Depuis la racine du projet, environnement virtuel activé, `.env` avec `N2YO_API_KEY` renseigné :

```bash
python scripts/generate_angle_dataset.py   # ~1 min, crée data/processed/angle_training_data.csv
python scripts/train_angle_model.py        # ~1 min, crée models/angle_model.joblib et affiche les scores
python scripts/validate_angle_model.py     # doit finir par « 18/18 vérifications réussies »
```

Sans clé N2YO ni internet, tout fonctionne quand même grâce aux orbites en cache
(`data/tle_cache.json`).

Tester une prédiction dans le terminal :

```bash
python scripts/predict_angle.py --live 25544 --dust 30              # ISS en direct
python scripts/predict_angle.py --elevation 40 --dust 90 --temp 30  # scénario inventé
```

Le modèle `.joblib` ne se charge qu'avec la même version de scikit-learn que celle
qui l'a entraîné : après une mise à jour des dépendances, relancer `train_angle_model.py`.

## Performances (données de test)

| | Formule simple | Modèle IA |
|---|---|---|
| Erreur moyenne (au soleil) | 7,9° | **0,45°** |
| R² (au soleil) | 0,72 | **0,999** |
| Énergie récupérée | 96,8 % | **99,9 %** |

R² élevé mais honnête : la cible est une formule physique exacte (+ bruit de 0,5°),
et le test des cibles mélangées fait tomber le R² à 0 (pas de fuite de données).

## Utilisation depuis le backend

Ce modèle est une expérimentation appelable par code ou par script; il n'est pas chargé par l'API ni par le cycle courant.
Le cycle applicatif charge uniquement `models/power_model.joblib` via `PowerPredictor`; en son absence, il utilise le fallback physique.

```python
from backend.app.modules.data_twin.ephemeris import sun_from_earth_orbit
from backend.app.modules.data_twin.satellite_source import get_satellite_position
from backend.app.modules.intelligence.angle_physics import simulate_surface_temp
from backend.app.modules.intelligence.angle_predictor import predict_with_confidence

position = get_satellite_position(25544)                     # 1. position (N2YO)
sun = sun_from_earth_orbit(position)                         # 2. soleil (Skyfield)
temp = float(simulate_surface_temp(sun.elevation_deg, sun.sunlit))  # 3. température estimée
result = predict_with_confidence(sun.elevation_deg, sun.azimuth_deg, sun.sunlit,
                                 dust_level=30, surface_temp=temp)
# result = {"angle": 52.3, "uncertainty": 0.4, "confident": True}
```

### Fonctions disponibles

| Fonction | Entrées | Renvoie |
|---|---|---|
| `get_satellite_position(norad_id)` | ID NORAD (25544 = ISS, 20580 = Hubble, 33591 = NOAA-19) | `GeoPosition(lat_deg, lon_deg, alt_km)` |
| `sun_from_earth_orbit(position)` | position du satellite | `SunPosition(azimuth_deg, elevation_deg, sunlit)` |
| `simulate_surface_temp(elevation, is_sunlit)` | soleil | température de surface estimée (°C) |
| `predict_optimal_angle(elevation, azimuth, is_sunlit, dust_level, surface_temp)` | les 5 entrées | angle optimal (°) : 0 = à plat, 90 = vertical |
| `predict_with_confidence(...)` | mêmes entrées | `{"angle", "uncertainty" (± °), "confident" (bool)}` |
| `orbit_sun_series(get_satellite_tle(norad_id), n_points=90)` | orbite, 1 point/minute | tableaux : `sat_lat, sat_lon, sat_alt, sun_elevation, sun_azimuth, is_sunlit` |
| `compute_optimal_angle(...)` / `panel_power(tilt, ...)` | formule physique | angle de référence / puissance relative (0-1) |

### Bon à savoir

- **Quota N2YO** : ~1000 requêtes/heure en gratuit. `get_satellite_position` réutilise la même
  position pendant 10 s.
- **N2YO hors ligne** : la position est calculée depuis l'orbite en cache
  (écart < 0,1° avec la vraie position).
- **Valeurs impossibles** (élévation hors [-90, 90], poussière hors [0, 100]) : `predict_*`
  lève une `ValueError` avec un message clair.
- **`confident = False`** : situation rare pour le modèle, afficher l'angle avec prudence.
- **Unités** : ici la poussière est en % (0-100), alors que `dust_factor` dans
  `core/contracts.py` est un facteur de transmission (0-1). Convertir à l'intégration.
