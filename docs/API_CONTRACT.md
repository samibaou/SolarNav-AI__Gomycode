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

Frontend and backend must treat `TwinState` in `backend/app/core/contracts.py` as the shared contract.
