"""Entraîne le modèle hybride (physique + ExtraTrees) qui prédit l'angle optimal du panneau."""

from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import GroupKFold

from backend.app.modules.intelligence.angle_dataset import DATASET_PATH, generate_dataset
from backend.app.modules.intelligence.angle_model import FEATURES, MODEL_PATH, TARGET, PhysicsResidualModel
from backend.app.modules.intelligence.angle_physics import energy_ratio

# Les lignes issues des orbites sont espacées d'1 minute : deux lignes voisines sont
# presque identiques. On découpe train/test par blocs d'1 heure pour éviter que le
# test contienne des quasi-doublons du train (score artificiellement bon).
SPLIT_BLOCK_ROWS = 60
N_FOLDS = 5
STRESS_SAMPLES = 5000
GITHUB_WARN_MB = 50


def simple_formula(X: pd.DataFrame) -> np.ndarray:
    """Formule simple sans IA : panneau face au soleil, ignore ombre, poussière et chaleur."""
    return np.clip(90.0 - X["sun_elevation"].to_numpy(), 0, 90)


def evaluate(X: pd.DataFrame, y, y_pred) -> dict:
    """Métriques de précision.

    Sur tous les scénarios : r2_all, mae_all.
    Sur les scénarios au soleil (les seuls où l'angle change l'énergie produite) :
    - r2, mae : R² et erreur moyenne en degrés
    - within_2deg : part des prédictions à moins de 2° de l'optimum
    - energy : part moyenne de l'énergie maximale récupérée avec l'angle prédit
    - energy_worst_1pct : énergie récupérée dans les 1 % pires cas
    """
    y = np.asarray(y)
    sunlit = X["is_sunlit"].to_numpy() == 1
    error = np.abs(y - y_pred)[sunlit]
    energy = energy_ratio(
        y_pred[sunlit],
        X["sun_elevation"].to_numpy()[sunlit],
        X["dust_level"].to_numpy()[sunlit],
        X["surface_temp"].to_numpy()[sunlit],
    )
    return {
        "r2_all": r2_score(y, y_pred),
        "mae_all": mean_absolute_error(y, y_pred),
        "r2": r2_score(y[sunlit], y_pred[sunlit]),
        "mae": error.mean(),
        "within_2deg": (error <= 2).mean(),
        "energy": energy.mean(),
        "energy_worst_1pct": np.percentile(energy, 1),
    }


def _print_scores(title: str, scores: list[dict]) -> None:
    df = pd.DataFrame(scores)
    mean, std = df.mean(), df.std().fillna(0)
    print(f"\n{title}")
    print(f"  R² (tous scénarios)       : {mean.r2_all:.3f} ± {std.r2_all:.3f}   "
          f"erreur moyenne {mean.mae_all:.2f}°")
    print(f"  R² (au soleil)            : {mean.r2:.3f} ± {std.r2:.3f}   "
          f"erreur moyenne {mean.mae:.2f}° ± {std.mae:.2f}")
    print(f"  Prédictions à ±2°         : {100 * mean.within_2deg:.1f} % ± {100 * std.within_2deg:.1f}")
    print(f"  Énergie récupérée         : {100 * mean.energy:.2f} % ± {100 * std.energy:.2f}")
    print(f"  Énergie, 1 % pires cas    : {100 * mean.energy_worst_1pct:.2f} %")


HARD_CASES = {
    "Ombre": lambda X: X.is_sunlit == 0,
    "Poussière forte (> 80 %)": lambda X: (X.is_sunlit == 1) & (X.dust_level > 80),
    "Surchauffe (> 100 °C)": lambda X: (X.is_sunlit == 1) & (X.surface_temp > 100),
    "Soleil haut (> 70°)": lambda X: (X.is_sunlit == 1) & (X.sun_elevation > 70),
    "Soleil rasant (0-10°)": lambda X: (X.is_sunlit == 1) & X.sun_elevation.between(0, 10),
    "Soleil sous l'horizon local": lambda X: (X.is_sunlit == 1) & (X.sun_elevation < 0),
}


def _print_hard_cases(X: pd.DataFrame, y, y_pred) -> None:
    """Erreur par situation difficile, IA contre formule simple (données de test)."""
    y, simple = np.asarray(y), simple_formula(X)
    print("\nCas difficiles (données de test)")
    print(f"  {'Situation':<28} {'lignes':>6} | {'IA : moy.':>9} {'max':>6} | {'formule : moy.':>14}")
    for name, select in HARD_CASES.items():
        mask = select(X).to_numpy()
        if not mask.any():
            continue
        err_ai = np.abs(y - y_pred)[mask]
        err_simple = np.abs(y - simple)[mask]
        print(f"  {name:<28} {mask.sum():>6} | {err_ai.mean():>8.2f}° {err_ai.max():>5.1f}° | {err_simple.mean():>13.2f}°")


def train_model(dataset_path: Path = DATASET_PATH) -> PhysicsResidualModel:
    """Valide le modèle (validation croisée + test de stress), puis l'entraîne sur tout le dataset."""
    df = pd.read_csv(dataset_path)
    X, y = df[FEATURES], df[TARGET]
    groups = np.arange(len(df)) // SPLIT_BLOCK_ROWS
    print(f"Dataset : {len(df)} scénarios")

    # Validation croisée : 5 découpages différents -> score moyen ± variation (fiabilité).
    # Chaque ligne est prédite une fois par un modèle qui ne l'a jamais vue (out-of-fold).
    train_scores, test_scores = [], []
    out_of_fold = np.zeros(len(df))
    for train_idx, test_idx in GroupKFold(n_splits=N_FOLDS).split(X, y, groups):
        model = PhysicsResidualModel().fit(X.iloc[train_idx], y.iloc[train_idx])
        out_of_fold[test_idx] = model.predict(X.iloc[test_idx])
        test_scores.append(evaluate(X.iloc[test_idx], y.iloc[test_idx], out_of_fold[test_idx]))
        train_scores.append(evaluate(X.iloc[train_idx], y.iloc[train_idx], model.predict(X.iloc[train_idx])))

    _print_scores(f"Données de TEST (validation croisée, {N_FOLDS} plis)", test_scores)
    gap = pd.DataFrame(test_scores).mae.mean() - pd.DataFrame(train_scores).mae.mean()
    print(f"  Écart entraînement/test   : erreur {pd.DataFrame(train_scores).mae.mean():.2f}° en "
          f"entraînement contre {pd.DataFrame(test_scores).mae.mean():.2f}° en test ({gap:+.2f}° en test : pas de surapprentissage)")

    simple = evaluate(X, y, simple_formula(X))
    print(f"\nFormule simple sans IA (ignore ombre, poussière, chaleur), mêmes données :")
    print(f"  R² (tous scénarios)       : {simple['r2_all']:.3f}   erreur moyenne {simple['mae_all']:.2f}°")
    print(f"  R² (au soleil)            : {simple['r2']:.3f}   erreur moyenne {simple['mae']:.2f}°")
    print(f"  Énergie récupérée         : {100 * simple['energy']:.2f} %  "
          f"(1 % pires cas : {100 * simple['energy_worst_1pct']:.2f} %)")

    _print_hard_cases(X, y, out_of_fold)

    # Modèle final entraîné sur tout le dataset
    model = PhysicsResidualModel().fit(X, y)

    # Test de stress : situations extrêmes jamais vues (GEO, Lune, soleil au zénith, températures limites)
    stress = generate_dataset(STRESS_SAMPLES, seed=999, use_real_orbits=False)
    _print_scores("Test de stress (dataset neuf, situations extrêmes jamais vues)",
                  [evaluate(stress[FEATURES], stress[TARGET], model.predict(stress[FEATURES]))])

    print("\nImportance des variables (dans la correction apprise) :")
    importances = sorted(zip(FEATURES, model.feature_importances_), key=lambda p: -p[1])
    for name, importance in importances:
        print(f"  {name:<14} {importance:.3f}")

    return model


def save_model(model, path: Path = MODEL_PATH) -> None:
    """Sauvegarde le modèle (joblib)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, path, compress=3)
    size_mb = path.stat().st_size / 1e6
    print(f"\nModèle sauvegardé dans {path} ({size_mb:.1f} Mo)")
    if size_mb > GITHUB_WARN_MB:
        print(f"  ATTENTION : plus de {GITHUB_WARN_MB} Mo, GitHub avertit (et refuse au-delà de 100 Mo).")
    else:
        print(f"  OK pour GitHub (< {GITHUB_WARN_MB} Mo)")

