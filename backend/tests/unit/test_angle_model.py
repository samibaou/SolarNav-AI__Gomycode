import numpy as np
import pytest

from backend.app.modules.intelligence.angle_dataset import generate_dataset
from backend.app.modules.intelligence.angle_model import FEATURES, TARGET, PhysicsResidualModel
from backend.app.modules.intelligence.angle_physics import (
    MAX_TILT,
    STOW_ANGLE,
    compute_optimal_angle,
    energy_ratio,
)
from backend.app.modules.intelligence.angle_training import evaluate


@pytest.fixture(scope="module")
def dataset():
    return generate_dataset(n_samples=3000, seed=7, use_real_orbits=False)


def test_optimal_angle_is_stow_in_shadow():
    assert compute_optimal_angle(40, False, 50, -120)[0] == STOW_ANGLE


def test_optimal_angle_faces_sun_without_dust_or_heat():
    # Sans poussière ni surchauffe, le panneau fait face au soleil : 90 - élévation
    assert compute_optimal_angle(30, True, 0, 0)[0] == pytest.approx(60, abs=0.5)


def test_optimal_angle_respects_mechanical_limit():
    angles = compute_optimal_angle(np.linspace(-90, 90, 50), np.ones(50), np.full(50, 100), np.full(50, 160))
    assert angles.min() >= 0 and angles.max() <= MAX_TILT


def test_dust_tilts_panel_more():
    clean = compute_optimal_angle(60, True, 0, 20)[0]
    dusty = compute_optimal_angle(60, True, 100, 20)[0]
    assert dusty > clean


def test_energy_ratio_is_one_at_optimum():
    elevation, dust, temp = np.array([40.0]), np.array([30.0]), np.array([60.0])
    best = compute_optimal_angle(elevation, np.ones(1), dust, temp)
    assert energy_ratio(best, elevation, dust, temp)[0] == pytest.approx(1.0)


def test_dataset_schema_and_ranges(dataset):
    assert list(dataset.columns) == [*FEATURES, TARGET]
    assert dataset[TARGET].between(0, MAX_TILT).all()
    assert dataset["dust_level"].between(0, 100).all()


def test_residual_model_beats_simple_formula(dataset):
    train, test = dataset.iloc[:2400], dataset.iloc[2400:]
    model = PhysicsResidualModel(n_estimators=30).fit(train[FEATURES], train[TARGET])
    scores = evaluate(test[FEATURES], test[TARGET], model.predict(test[FEATURES]))
    assert scores["mae"] < 3.0
    assert scores["energy"] > 0.99

    angles, uncertainty = model.predict_with_uncertainty(test[FEATURES])
    assert angles.shape == uncertainty.shape == (len(test),)
    assert (uncertainty >= 0).all()
