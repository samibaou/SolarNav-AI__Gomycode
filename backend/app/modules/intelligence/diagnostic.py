from __future__ import annotations

from backend.app.core.contracts import DiagnosticResult, PhysicsResult, TwinState


ANOMALY_THRESHOLD_PCT = 20.0


def diagnose(state: TwinState, physics: PhysicsResult) -> DiagnosticResult:
    observed = state.energy.observed_power_w
    if observed is None:
        return DiagnosticResult(
            status="NO_DATA",
            performance_gap_pct=0.0,
            message="No observed power is available for comparison.",
        )

    expected = physics.expected_power_w
    if expected < 1.0:
        if observed <= 5.0:
            return DiagnosticResult(
                status="OK",
                performance_gap_pct=0.0,
                message="Low observed power is consistent with low expected sunlight.",
            )
        return DiagnosticResult(
            status="ANOMALY",
            performance_gap_pct=100.0,
            message="Observed power is unexpectedly high while expected solar power is near zero.",
        )

    gap_pct = (expected - observed) / expected * 100.0
    status = "ANOMALY" if abs(gap_pct) > ANOMALY_THRESHOLD_PCT else "OK"
    message = (
        "Observed power differs significantly from the physical baseline."
        if status == "ANOMALY"
        else "Observed power is consistent with the physical baseline."
    )
    return DiagnosticResult(status=status, performance_gap_pct=round(gap_pct, 4), message=message)
