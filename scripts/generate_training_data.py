from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import csv
import random
from datetime import datetime, timezone

from backend.app.core.config import settings
from backend.app.core.contracts import RawInput
from backend.app.modules.data_twin.pipeline import build_twin_state
from backend.app.modules.intelligence.ml import FEATURE_NAMES, feature_vector
from backend.app.modules.intelligence.physics import estimate_power

OUTPUT = settings.root_dir / "data" / "processed" / "training_data.csv"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
rng = random.Random(42)

with OUTPUT.open("w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow([*FEATURE_NAMES, "target_power_w"])
    for _ in range(15000):
        raw = RawInput(
            timestamp=datetime.now(timezone.utc),
            sun_azimuth_deg=rng.uniform(0, 360),
            sun_elevation_deg=rng.uniform(-5, 20),
            panel_azimuth_deg=rng.uniform(0, 360),
            panel_tilt_deg=rng.uniform(0, 90),
            battery_soc_pct=rng.uniform(10, 95),
            illumination=rng.uniform(.5, 1.0),
            shadow_probability=rng.uniform(0, .8),
            dust_factor=rng.uniform(.75, 1.0),
            observed_power_w=None,
        )
        state = build_twin_state(raw)
        target = estimate_power(state, settings).expected_power_w
        writer.writerow([*feature_vector(state), target])
print(OUTPUT)
