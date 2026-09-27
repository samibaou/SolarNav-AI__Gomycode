from __future__ import annotations

from typing import Protocol

import httpx

from backend.app.core.config import Settings
from backend.app.core.contracts import DiagnosticResult, OptimizationResult, TwinState
from backend.app.modules.llm_agent.prompts import SYSTEM_PROMPT


class ExplanationProvider(Protocol):
    source_name: str

    def explain(
        self,
        *,
        state: TwinState,
        optimization: OptimizationResult,
        diagnostic: DiagnosticResult,
        action: str,
    ) -> str:
        ...


class TemplateExplanationProvider:
    source_name = "template"

    def explain(
        self,
        *,
        state: TwinState,
        optimization: OptimizationResult,
        diagnostic: DiagnosticResult,
        action: str,
    ) -> str:
        if action == "MOVE":
            return (
                f"Move to tilt {optimization.best.tilt_deg:.0f}° and azimuth "
                f"{optimization.best.azimuth_deg:.0f}° because the estimated net gain is "
                f"{optimization.net_gain_wh:.2f} Wh. Diagnostic: {diagnostic.status}."
            )
        return (
            f"Hold the current orientation because the best alternative adds only "
            f"{optimization.net_gain_wh:.2f} Wh over the optimization horizon."
        )


class NvidiaNIMExplanationProvider:
    source_name = "nvidia_nim"

    def __init__(self, settings: Settings):
        self.settings = settings

    def explain(
        self,
        *,
        state: TwinState,
        optimization: OptimizationResult,
        diagnostic: DiagnosticResult,
        action: str,
    ) -> str:
        url = self.settings.nim_base_url.rstrip("/") + "/chat/completions"
        user_message = {
            "action": action,
            "battery_soc_pct": state.battery.soc_pct,
            "current_tilt_deg": state.panel.tilt_deg,
            "current_azimuth_deg": state.panel.azimuth_deg,
            "target_tilt_deg": optimization.best.tilt_deg,
            "target_azimuth_deg": optimization.best.azimuth_deg,
            "net_gain_wh": optimization.net_gain_wh,
            "diagnostic": diagnostic.model_dump(),
        }
        response = httpx.post(
            url,
            headers={
                "Authorization": f"Bearer {self.settings.nim_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.settings.nim_model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": str(user_message)},
                ],
                "temperature": 0.1,
                "max_tokens": 120,
            },
            timeout=self.settings.nim_timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        text = payload["choices"][0]["message"]["content"]
        if not isinstance(text, str) or not text.strip():
            raise ValueError("NIM returned an empty explanation")
        return text.strip()
