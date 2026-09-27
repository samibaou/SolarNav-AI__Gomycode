import pytest

from backend.app.modules.data_twin.lunar_environment import (
    disk_illumination,
    dust_factor,
    terrain_shadow_probability,
)


def test_half_solar_disk_visible_when_centered_on_horizon():
    assert disk_illumination(0.0) == pytest.approx(0.5)


def test_solar_disk_fully_visible_or_hidden_beyond_its_radius():
    assert disk_illumination(1.0) == 1.0
    assert disk_illumination(-1.0) == 0.0


def test_illumination_increases_with_sun_elevation():
    values = [disk_illumination(x) for x in (-0.3, -0.1, 0.0, 0.1, 0.3)]
    assert values == sorted(values)


def test_terrain_shadow_decreases_with_sun_elevation():
    assert terrain_shadow_probability(-2.0) >= terrain_shadow_probability(1.0) > terrain_shadow_probability(2.5)
    assert terrain_shadow_probability(10.0) == 0.0
    assert 0.0 <= terrain_shadow_probability(-90.0) <= 1.0


def test_dust_accumulates_and_stays_bounded():
    assert dust_factor(0) == 1.0
    assert dust_factor(30) < dust_factor(10) < 1.0
    assert dust_factor(100_000) == pytest.approx(0.5)


def test_negative_days_since_cleaning_is_rejected():
    with pytest.raises(ValueError):
        dust_factor(-1)
