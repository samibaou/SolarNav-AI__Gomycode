# SolarNav AI — Final Hackathon Architecture

Architecture for an AI-assisted lunar solar-panel Digital Twin, organized for a 5-person team.

## Runtime data and models

- The canonical backend Twin starts from `data/sample_input.json`; these are demo inputs, not NASA observations.
- The 3D interface offers separate Simulation, Replay and Live sources. Live data comes from `GET /api/v1/data/live`: Open-Meteo and a calculated solar ephemeris on Earth, JPL Horizons on the Moon, and NASA DONKI/NOAA SWPC space-weather feeds. Each source reports `live`, `cache` or `fallback`; Earth fallback may use the committed NASA POWER replay, then a labelled simulation.
- Skyfield ephemerides and N2YO satellite positions are used by data-generation and angle-model scripts. They do not currently feed the API's normal simulation cycle.
- The runtime power predictor loads `models/power_model.joblib` when present; no trained artifact is committed, so the normal cycle uses the physics fallback. The separate `angle_model.joblib` experiment is trained and invoked with the scripts in `scripts/`; it does not select API optimizer targets.
- NVIDIA NIM is optional. Set `NIM_BASE_URL`, `NIM_API_KEY` and `NIM_MODEL` in the backend `.env`; without all three, or if the request fails, the agent returns a deterministic explanation. The LLM never selects panel angles.
- `/api/v1/weather/forecast` marks the origin as `live` or `unavailable`; unavailable forecasts return null metrics rather than simulated measurements.

## Functional flow

```text
INPUT DATA
   ↓
DATA PIPELINE
   ↓
DIGITAL TWIN (logical state)
   ↓
PHYSICS + ML + DIAGNOSTIC
   ↓
OPTIMIZER
   ↓
LLM AGENT (MOVE / HOLD + explanation)
   ↓
CONTROLLER
   ↓
UPDATED DIGITAL TWIN
   ↓
FASTAPI
   ↓
WEB DASHBOARD + VISUAL DIGITAL TWIN
```

## Team ownership

| Person | Ownership | Folder |
|---|---|---|
| P1 | Data Pipeline + logical Digital Twin | `backend/app/modules/data_twin/`, `data/` |
| P2 | Physics + ML + Diagnostic | `backend/app/modules/intelligence/`, `models/`, ML scripts |
| P3 | Optimizer + Controller | `backend/app/modules/decision_control/` |
| P4 | Frontend + visual Digital Twin | `frontend/` |
| P5 | LLM + FastAPI + integration | `backend/app/modules/llm_agent/`, `backend/app/api/`, `backend/app/orchestrator.py` |

Shared files: `backend/app/core/contracts.py` and `backend/app/core/config.py`. Do not change them without team agreement.

## Design rules

1. The optimizer computes target angles.
2. The LLM never invents or modifies target angles.
3. MOVE/HOLD is gated by a deterministic policy; the LLM explains the validated decision.
4. Frontend communicates with backend only through HTTP/JSON.
5. Power is in W; energy is in Wh. The optimizer compares energy with energy.
6. `main` stays demonstrable; feature branches merge into `develop` first.

## Quick start

```bash
python -m venv .venv
```

Windows:

```bash
.venv\Scripts\activate
```

macOS/Linux:

```bash
source .venv/bin/activate
```

Install:

```bash
pip install -r backend/requirements.txt
```

Optional backend settings are listed in `.env.example`. Keep credentials in the backend `.env`; never add that file to Git.

Run the complete app from repository root:

```bash
uvicorn backend.app.main:app --reload
```

Open `http://127.0.0.1:8000`.
The 3D interface is at `http://127.0.0.1:8000/digital_twin/index.html`; no separate frontend server is required.

Tests:

```bash
pytest backend/tests -q
python scripts/architecture_check.py
cd frontend && npm test
```

`npm test` runs the contract tests and the browser-based Digital Twin regression suite.

See `docs/` for architecture, API contract, ownership, test strategy and Git workflow.

## Optimal-angle AI model (satellite / lunar base)

Real satellite position (N2YO) + real sun geometry (Skyfield) + hybrid physics/ExtraTrees model
predicting the optimal panel tilt (0.45° mean error, 99.9 % of max energy).

```bash
python scripts/generate_angle_dataset.py
python scripts/train_angle_model.py
python scripts/validate_angle_model.py
python scripts/predict_angle.py --live 25544 --dust 30
```

Requires `N2YO_API_KEY` in `.env` (works offline with `data/tle_cache.json`).
Details (in French): [`docs/ANGLE_MODEL.md`](docs/ANGLE_MODEL.md).
