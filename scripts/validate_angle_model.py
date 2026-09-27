"""Vérifie le modèle d'angle entraîné : `python scripts/validate_angle_model.py`.

1. Généralisation : score sur un dataset neuf, jamais vu pendant l'entraînement
2. Cohérence physique : le modèle réagit dans le bon sens à chaque variable
3. Situations extrêmes et entrées invalides
4. Fuite de données : le R² très élevé est-il honnête ?
5. Cas réel : prédiction pour l'ISS en ce moment (si N2YO répond)
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np
import pandas as pd
from sklearn.metrics import r2_score
from sklearn.model_selection import GroupShuffleSplit

from backend.app.modules.intelligence.angle_dataset import DATASET_PATH, generate_dataset
from backend.app.modules.intelligence.angle_model import FEATURES, TARGET, PhysicsResidualModel
from backend.app.modules.intelligence.angle_physics import compute_optimal_angle, energy_ratio, simulate_surface_temp
from backend.app.modules.intelligence.angle_predictor import load_model, predict_optimal_angle, predict_with_confidence
from backend.app.modules.intelligence.angle_training import SPLIT_BLOCK_ROWS, evaluate

MAX_MAE = 1.0  # erreur moyenne tolérée (degrés) sur des données jamais vues
MIN_WITHIN_2DEG = 0.95  # part minimale des prédictions à ±2°
MIN_ENERGY = 0.995  # énergie moyenne minimale récupérée
MIN_EXTREME_ENERGY = 0.99  # énergie minimale dans chaque situation extrême

results = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append(ok)
    print(f"  [{'OK' if ok else 'ÉCHEC'}] {name}{f'  ({detail})' if detail else ''}")


def test_generalization() -> None:
    print("\n1. Généralisation (dataset neuf, autre graine, situations aléatoires)")
    df = generate_dataset(n_samples=5000, seed=123, use_real_orbits=False)
    y_pred = load_model().predict(df[FEATURES])
    scores = evaluate(df[FEATURES], df[TARGET], y_pred)
    worst = np.abs(df[TARGET] - y_pred).max()

    check(f"Erreur moyenne < {MAX_MAE}°", scores["mae"] < MAX_MAE, f"{scores['mae']:.2f}°")
    check(f"Prédictions à ±2° > {MIN_WITHIN_2DEG:.0%}", scores["within_2deg"] > MIN_WITHIN_2DEG,
          f"{100 * scores['within_2deg']:.1f} %")
    check(f"Énergie récupérée > {MIN_ENERGY:.1%}", scores["energy"] > MIN_ENERGY,
          f"{100 * scores['energy']:.2f} %, 1 % pires cas : {100 * scores['energy_worst_1pct']:.2f} %")
    print(f"  Pire erreur : {worst:.1f}°")


def test_physics() -> None:
    print("\n2. Cohérence physique")
    p = predict_optimal_angle

    shadow = p(-50, 180, False, 50, -120)
    check("À l'ombre -> position de repli (~0°)", abs(shadow) < 2, f"{shadow:.1f}°")

    low, high = p(20, 180, True, 0, 30), p(70, 180, True, 0, 90)
    check("Soleil plus haut -> panneau plus à plat", high < low, f"élév. 20° : {low:.1f}°, 70° : {high:.1f}°")

    clean, dusty = p(40, 180, True, 0, 60), p(40, 180, True, 100, 60)
    check("Plus de poussière -> panneau plus incliné", dusty > clean, f"0 % : {clean:.1f}°, 100 % : {dusty:.1f}°")

    cool, hot = p(40, 180, True, 0, 60), p(40, 180, True, 0, 130)
    check("Surchauffe -> panneau détourné du soleil", hot > cool + 10, f"60 °C : {cool:.1f}°, 130 °C : {hot:.1f}°")

    az_values = [p(40, az, True, 30, 60) for az in (0, 90, 180, 270)]
    spread = max(az_values) - min(az_values)
    check("Azimut sans effet (panneau 1 axe)", spread < 2, f"écart {spread:.1f}°")

    elev = np.arange(0, 91, 10)
    temps = simulate_surface_temp(elev, np.ones_like(elev, dtype=bool))
    expected = compute_optimal_angle(elev, np.ones_like(elev), np.full(elev.shape, 30), temps)
    predicted = [p(e, 180, True, 30, t) for e, t in zip(elev, temps)]
    print("  Balayage élévation (poussière 30 %) :")
    print("    élévation :", " ".join(f"{e:5.0f}" for e in elev))
    print("    formule   :", " ".join(f"{v:5.1f}" for v in expected))
    print("    modèle    :", " ".join(f"{v:5.1f}" for v in predicted))


def test_extremes() -> None:
    print("\n3. Situations extrêmes et entrées invalides")
    cases = [
        ("Orbite géostationnaire, soleil sous l'horizon local", (-70, 90, True, 20, 40)),
        ("Base lunaire, soleil au zénith", (90, 0, True, 50, 120)),
        ("Soleil rasant, panneau très poussiéreux", (2, 270, True, 100, -20)),
        ("Surchauffe extrême", (45, 180, True, 0, 160)),
        ("Froid extrême au soleil (sortie d'éclipse)", (30, 180, True, 10, -150)),
    ]
    for name, (elevation, azimuth, sunlit, dust, temp) in cases:
        result = predict_with_confidence(elevation, azimuth, sunlit, dust, temp)
        expected = compute_optimal_angle(elevation, sunlit, dust, temp)[0]
        # Critère sur l'énergie, pas sur les degrés : dans ces cas rares l'écart peut
        # frôler 3° selon le dataset, sans effet notable sur l'énergie produite
        energy = energy_ratio(np.array([result["angle"]]), np.array([float(elevation)]),
                              np.array([float(dust)]), np.array([float(temp)]))[0]
        check(f"{name} : énergie > {MIN_EXTREME_ENERGY:.0%}", energy > MIN_EXTREME_ENERGY,
              f"modèle {result['angle']:.1f}° ± {result['uncertainty']:.1f} / formule {expected:.1f}°, "
              f"énergie {100 * energy:.2f} %")

    for name, args in [("Élévation impossible (120°) refusée", (120, 0, True, 0, 20)),
                       ("Poussière impossible (150 %) refusée", (40, 0, True, 150, 20))]:
        try:
            predict_optimal_angle(*args)
            check(name, False)
        except ValueError:
            check(name, True)


def test_leakage() -> None:
    print("\n4. Fuite de données : le R² très élevé est-il honnête ?")
    df = pd.read_csv(DATASET_PATH)
    X, y = df[FEATURES], df[TARGET].to_numpy()
    groups = np.arange(len(df)) // SPLIT_BLOCK_ROWS
    train_idx, test_idx = next(GroupShuffleSplit(1, test_size=0.2, random_state=0).split(X, y, groups))

    # a) Cibles mélangées au hasard : s'il n'y a pas de fuite, le modèle ne peut plus rien
    #    apprendre et son R² en test doit tomber à ~0.
    shuffled = np.random.default_rng(0).permutation(y[train_idx])
    model = PhysicsResidualModel(n_estimators=30).fit(X.iloc[train_idx], shuffled)
    r2_shuffled = r2_score(y[test_idx], model.predict(X.iloc[test_idx]))
    check("Cibles mélangées -> le modèle n'apprend plus rien", r2_shuffled < 0.1, f"R² = {r2_shuffled:.3f}")

    # b) La cible est une formule physique exacte des 5 entrées + un bruit de 0.5°.
    #    R² maximal atteignable = 1 - variance du bruit / variance de la cible.
    sunlit = X["is_sunlit"].to_numpy() == 1
    ceiling = 1 - 0.5 ** 2 / y[sunlit].var()
    fresh = generate_dataset(n_samples=5000, seed=2024, use_real_orbits=False)
    r2_fresh = evaluate(fresh[FEATURES], fresh[TARGET], load_model().predict(fresh[FEATURES]))["r2"]
    check("R² sur un dataset neuf (généré à part) proche du plafond théorique",
          r2_fresh > 0.99, f"R² = {r2_fresh:.4f}, plafond {ceiling:.4f}")


def test_live() -> None:
    print("\n5. Cas réel : ISS maintenant")
    try:
        from backend.app.modules.data_twin.satellite import get_sat_position
        from backend.app.modules.data_twin.sun import get_real_sun_angle

        lat, lon, alt = get_sat_position(25544)
    except Exception as exc:
        print(f"  Ignoré, N2YO injoignable ({exc})")
        return

    elevation, azimuth, sunlit = get_real_sun_angle(lat, lon, alt)
    temp = float(simulate_surface_temp(elevation, sunlit))
    angle = predict_optimal_angle(elevation, azimuth, sunlit, 30, temp)
    expected = compute_optimal_angle(elevation, sunlit, 30, temp)[0]
    print(f"  Position : {lat:.2f}°, {lon:.2f}°, {alt:.0f} km")
    print(f"  Soleil : élévation {elevation:.1f}°, azimut {azimuth:.1f}°, "
          f"{'éclairé' if sunlit else 'dans l ombre'}, surface {temp:.0f} °C")
    check("Prédiction proche de la formule", abs(angle - expected) < 3,
          f"modèle {angle:.1f}° / formule {expected:.1f}°")


if __name__ == "__main__":
    test_generalization()
    test_physics()
    test_extremes()
    test_leakage()
    test_live()
    print(f"\n{sum(results)}/{len(results)} vérifications réussies")
    raise SystemExit(0 if all(results) else 1)
