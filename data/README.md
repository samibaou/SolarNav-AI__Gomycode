# Data — P1

Real sun data for SolarNav, computed from NASA/JPL ephemerides (Skyfield), for a
**lunar base** (south pole by default) or a **satellite** in Earth orbit (N2YO API).
The processing code lives in `backend/app/modules/data_twin/`; this folder holds the data.

## Files

| File | Content |
|---|---|
| `sample_input.json` | Static example input used by the app at startup |
| `tle_cache.json` | Last satellite orbits (TLE) received from N2YO: satellite mode works offline |
| `ephemeris/` | NASA/JPL files (~19 MB), downloaded automatically on first use, ignored by Git |
| `processed/` | Generated series, ignored by Git |

## Backend modules (`backend/app/modules/data_twin/`)

| Module | Role |
|---|---|
| `ephemeris.py` | Real sun position seen from the Moon or from a satellite (Skyfield) |
| `lunar_environment.py` | Illumination (exact solar disk geometry), terrain shadow and dust models |
| `satellite_source.py` | N2YO client: satellite position and TLE, 10 s cache, offline fallback |
| `live_source.py` | Builds `RawInput` contracts from real data |

## Use real data in the app

```python
from backend.app.modules.data_twin.live_source import lunar_raw_input, orbital_raw_input
from backend.app.modules.data_twin.pipeline import build_twin_state

state = build_twin_state(lunar_raw_input())       # lunar base, real sun now
state = build_twin_state(orbital_raw_input(25544)) # ISS, real position and sun now
```

Replacing `load_raw_input(settings.data_file)` in `backend/app/dependencies.py` with
`lunar_raw_input()` starts the app with the real sun instead of the static example.

| RawInput field | Source |
|---|---|
| `sun_azimuth_deg`, `sun_elevation_deg` | **Real**: NASA/JPL ephemerides + lunar orientation (NAIF) |
| `illumination` | **Exact geometry**: fraction of the solar disk above the horizon |
| `shadow_probability` | Simulated: terrain hides a low sun (< 3 deg) |
| `dust_factor` | Simulated: dust accumulates every day (-11 % after 30 days) |
| `panel_*`, `battery_soc_pct` | Parameters (defaults = `sample_input.json`) |

At the lunar south pole the sun always stays within 2 deg of the horizon (the Moon's
axis is tilted by only 1.54 deg): this is why Artemis bases are planned there
(near-permanent light), and why every tenth of a degree of elevation matters.

## Commands

```bash
# 30 days of real lunar sun data, 1 point per hour -> data/processed/lunar_raw_inputs.json
python -m backend.app.modules.data_twin.live_source --days 30 --step 60

# P1 tests (no network or API key needed: N2YO is mocked)
pytest backend/tests/unit/test_lunar_environment.py backend/tests/unit/test_real_data_sources.py -q
```

## Configuration (`.env` at the repository root)

```
N2YO_API_KEY=your_key            # satellite mode only, free on n2yo.com
SOLARNAV_LUNAR_LAT_DEG=-89.5     # lunar base site
SOLARNAV_LUNAR_LON_DEG=0.0
```
