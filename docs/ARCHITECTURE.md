# SolarNav AI — Architecture finale

## Separation

```text
FRONTEND (P4)
HTML / CSS / JavaScript
Dashboard + visual Digital Twin
        │ HTTP / JSON
        ▼
FASTAPI (P5)
        ▼
ORCHESTRATOR (P5)
        │
        ├── P1 Data Pipeline + logical Digital Twin
        ├── P2 Physics + ML + Diagnostic
        ├── P3 Optimizer + Controller
        └── P5 LLM explanation layer
```

## Logical vs visual Digital Twin

- `backend/app/modules/data_twin/`: canonical state and simulation logic.
- `frontend/digital_twin/`: visualization only; never the source of truth.

## Dependency direction

Lower layers must not import higher-level decision layers. `scripts/architecture_check.py` verifies this.

## Units

The optimizer compares energy in Wh:

```text
solar_energy_wh = predicted_power_w × horizon_hours
net_energy_wh = solar_energy_wh - motor_cost_wh
```

Never subtract Wh from W.

## LLM boundary

```text
Optimizer → target angle
Deterministic policy → MOVE/HOLD
LLM → explanation
Controller → validates optimizer target
```

## Persistence

The demo uses a thread-safe in-memory store. It is correct for one Uvicorn process. For multi-worker/production use, replace it with Redis or a database.

## Frontend resilience

The visual twin tries Three.js. If the CDN is unavailable, it falls back to a built-in Canvas renderer so the demo remains usable.
