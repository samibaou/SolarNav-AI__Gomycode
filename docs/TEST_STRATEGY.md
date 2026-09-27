# Test strategy

No finite suite can prove that every possible defect is absent. This repository uses complementary layers.

## Static
- Python compilation.
- JavaScript syntax.
- module dependency boundaries.
- frontend/backend separation.
- basic secret scan.

## Unit
- P1 validation, azimuth normalization, movement, battery and time.
- P2 horizon/shadow/dust/alignment, diagnostic, ML fallback.
- P3 circular angles, Wh optimization, no-sun behavior, controller validation.
- P5 MOVE/HOLD thresholds and angle ownership.

## Integration
- full orchestrator cycle.
- read-only actions do not mutate state.
- SOC stays bounded and time advances.

## API
- health, validation, state contract, optimize, agent and cycle.

## Architecture
- stable public keys.
- unknown input fields rejected.
- thread-safety smoke test.

## Frontend
- JS syntax and TwinState contract checks.

Future NASA/SPICE tests should add reference ephemeris fixtures and coordinate/time convention tests. A real trained model should add reproducibility, MAE/RMSE acceptance and model-version tests.
