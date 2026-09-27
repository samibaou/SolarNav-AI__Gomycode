# Visual Digital Twin (P4)

3D digital twin of the SolarNav station: physical sky driven by the sun position, desert terrain (Ouarzazate) or lunar
south pole, 4 dual-axis trackers, virtual sensors, heatmaps, NASA POWER replay, live data and backend decisions through
a 3-mode validation gate, and simulated weather scenarios for demos.
Visualization only: the canonical state lives in `backend/app/modules/data_twin/` (see `docs/ARCHITECTURE.md`).

## Open it

- Through the backend (full features): `uvicorn backend.app.main:app --reload`, then http://127.0.0.1:8000/digital_twin/index.html
- Standalone: open `frontend/digital_twin/index.html` from `file://` — simulation, replay and scenarios work; Live and
  "API IA" need the backend (relative `/api/v1` URLs) and fall back to the local policy.

Three.js r128 and its `Sky` / `Lensflare` / `OrbitControls` add-ons are loaded from the jsDelivr / cdnjs CDNs.

## Layout

| Path | Role |
|---|---|
| `index.html` | Page, UI, physics model, sensors, heatmap, wiring |
| `js/scenery.js` | Realistic scenery: sky, terrain, station equipment, clouds and their ground shadows; lunar site (grey cratered ground, black sky) — visual only |
| `js/datasource.js` | Data sources: `simulation`, `replay` (NASA POWER / CSV / JSON), `live` (backend `GET /api/v1/data/live`, Earth / Moon) |
| `js/backend.js` | HTTP adapter to `/api/v1` (`contracts.py`): `POST /agent/decision`, `GET /analysis`; W→kW for display, `dust_factor`→`dustPct`, one decision → 4 panels |
| `js/decision.js` | Local policy with French `reason` (tracking, STOW for wind / hail / space weather / night, snow, diffuse light) and the "API IA" provider (backend decision applied only in Live, local fallback) |
| `js/gate.js` | Validation gate, 3 autonomy modes (Manuel / Semi-auto / Full auto), queue with Approve / Refuse, 30 s timeout, decision log |
| `js/weatherfx.js` | Weather scenarios (sand, rain, hail, snow, heat, fog, solar storm), progressive effects, light Three.js particles, 60 s auto demo |
| `data/` | NASA POWER hourly sample, Ouarzazate / Noor, 18–24 June 2024 |
| `CONTRACT.md` | Twin ↔ backend contract (routes, adapter, decisions, gate, scenarios, data sources) |
| `tests/run.mjs` | Headless Chrome regression suite (+ `baseline.json`) |
| `scene.js` | Existing lightweight twin used by the dashboard (`frontend/index.html`) — unchanged |

## Test

```bash
cd frontend
npm test            # contract tests (existing)
npm run test:twin   # 3D twin: load, UI, physics, sensors, rendering, data sources, live, moon, decisions, gate, scenarios, baseline
```
`test:twin` needs Chrome or Edge (set `CHROME_PATH` if it is not found); it includes a fake `/api/v1` backend (no network).
