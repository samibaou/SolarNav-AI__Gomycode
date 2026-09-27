# API contract

Base path: `/api/v1`

## GET `/state`
Returns the canonical Digital Twin state.

## POST `/state/reset`
Creates a scenario from `RawInput`.

## GET `/analysis`
Returns Physics + ML + Diagnostic. Read-only.

## POST `/optimize`
Returns the best orientation in Wh-based optimization. Read-only.

## POST `/agent/decision`
Returns structured `MOVE/HOLD` plus explanation. Read-only.

## POST `/simulation/cycle`
Runs the whole pipeline and updates the Digital Twin.

Example body:

```json
{"step_minutes": 5}
```

## GET `/data/live?mode=earth|moon`
Real-time environment for the visual twin (P1, `backend/app/modules/data_twin/live/`). Read-only.
Earth: Open-Meteo irradiance/weather for Ouarzazate. Moon: JPL Horizons Sun azimuth/elevation at the lunar south pole.
Space weather from NASA DONKI + NOAA SWPC; a strong alert adds `SPACE_WEATHER` and proposes `STOW`.
Every block carries its `source` (`label`, `status` live/cache/fallback, `updated_at`, `age_s`).
Cached 5–15 min per source; failures fall back to last known value → NASA POWER replay → simulation.
Needs `NASA_API_KEY` in `.env` (empty = `DEMO_KEY`, 50 requests/day).

Frontend and backend must treat `TwinState` in `backend/app/core/contracts.py` as the shared contract.
