# Architecture review — defects found and corrections

## Critical

1. **Power/energy unit error** — subtracting motor Wh from solar W is invalid. Corrected: optimizer scores all candidates in Wh over a configurable horizon.
2. **LLM had too much actuator authority** — corrected: optimizer owns angles, deterministic policy owns MOVE/HOLD, LLM explains only, controller rejects non-optimizer angles.
3. **Frontend/backend responsibilities were mixed** — corrected with strict `frontend/` and `backend/` separation and HTTP/JSON contracts.

## High

4. **Digital Twin state was ephemeral** — added thread-safe state store.
5. **No strict API contract** — added Pydantic immutable contracts, forbidden unknown fields and range validation.
6. **CORS/deployment ambiguity** — FastAPI serves the frontend for the demo; restricted localhost CORS remains for separate dev.
7. **3D CDN could fail** — Canvas fallback keeps the demo working offline from the CDN.

## Medium

8. **Missing ML model could crash or block the team** — physics fallback keeps pipeline functional.
9. **Missing NVIDIA/LLM could block demo** — template/fallback explanation keeps cycle functional.
10. **Battery did not evolve** — cycle updates SOC from generated energy, load and movement cost.
11. **Merge-conflict risk** — folder ownership, develop branch, PR template and CI added.
12. **Single-process state limitation was undocumented** — now explicit; Redis/database is the later production replacement.
