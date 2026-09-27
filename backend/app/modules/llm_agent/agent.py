from __future__ import annotations

from backend.app.core.config import Settings
from backend.app.core.contracts import Decision, DiagnosticResult, OptimizationResult, TwinState
from backend.app.modules.llm_agent.providers import (
    ExplanationProvider,
    NvidiaNIMExplanationProvider,
    TemplateExplanationProvider,
)


class SolarNavAgent:
    """Deterministic MOVE/HOLD policy plus optional LLM explanation."""

    def __init__(self, settings: Settings, provider: ExplanationProvider | None = None):
        self.settings = settings
        self.template = TemplateExplanationProvider()
        if provider is not None:
            self.provider = provider
        elif settings.nim_enabled:
            self.provider = NvidiaNIMExplanationProvider(settings)
        else:
            self.provider = self.template

    def decide(
        self,
        *,
        state: TwinState,
        optimization: OptimizationResult,
        diagnostic: DiagnosticResult,
    ) -> Decision:
        action = "MOVE" if optimization.net_gain_wh >= self.settings.min_move_gain_wh else "HOLD"
        target_tilt = optimization.best.tilt_deg if action == "MOVE" else state.panel.tilt_deg
        target_azimuth = optimization.best.azimuth_deg if action == "MOVE" else state.panel.azimuth_deg
        source = self.provider.source_name
        try:
            reason = self.provider.explain(
                state=state,
                optimization=optimization,
                diagnostic=diagnostic,
                action=action,
            )
        except Exception:
            reason = self.template.explain(
                state=state,
                optimization=optimization,
                diagnostic=diagnostic,
                action=action,
            )
            source = "fallback"

        return Decision(
            action=action,
            target_tilt_deg=target_tilt,
            target_azimuth_deg=target_azimuth,
            reason=reason,
            explanation_source=source,
        )
