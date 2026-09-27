# SolarNav AI — Final Hackathon Architecture

Architecture for an AI-assisted lunar solar-panel Digital Twin, organized for a 5-person team.

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

Run the complete app from repository root:

```bash
uvicorn backend.app.main:app --reload
```

Open `http://127.0.0.1:8000`.

Tests:

```bash
pytest backend/tests -q
python scripts/architecture_check.py
cd frontend && npm test
```

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
