from __future__ import annotations

from threading import RLock

from backend.app.core.config import Settings
from backend.app.core.contracts import AnalysisBundle, CycleResult, Decision, OptimizationResult, TwinState
from backend.app.modules.data_twin.digital_twin import DigitalTwin
from backend.app.modules.data_twin.store import DigitalTwinStore
from backend.app.modules.decision_control.controller import apply_decision
from backend.app.modules.decision_control.optimizer import optimize
from backend.app.modules.intelligence.diagnostic import diagnose
from backend.app.modules.intelligence.ml import PowerPredictor
from backend.app.modules.intelligence.physics import estimate_power
from backend.app.modules.llm_agent.agent import SolarNavAgent


class SolarNavOrchestrator:
    def __init__(self, *, store: DigitalTwinStore, settings: Settings):
        self.store = store
        self.settings = settings
        self.predictor = PowerPredictor(settings)
        self.agent = SolarNavAgent(settings)
        self._cycle_lock = RLock()

    def analyze(self, state: TwinState | None = None) -> AnalysisBundle:
        state = state or self.store.get()
        physics = estimate_power(state, self.settings)
        ml = self.predictor.predict(state)
        diagnostic = diagnose(state, physics)
        return AnalysisBundle(physics=physics, ml=ml, diagnostic=diagnostic)

    def optimize_current(self) -> OptimizationResult:
        return optimize(self.store.get(), self.settings)

    def recommend(self) -> Decision:
        state = self.store.get()
        analysis = self.analyze(state)
        optimization = optimize(state, self.settings)
        return self.agent.decide(
            state=state,
            optimization=optimization,
            diagnostic=analysis.diagnostic,
        )

    def run_cycle(self, step_minutes: float | None = None) -> CycleResult:
        # Serialize state-changing cycles inside this Python process to avoid
        # lost updates when two requests arrive at the same time.
        with self._cycle_lock:
            initial = self.store.get()
            analysis = self.analyze(initial)
            optimization = optimize(initial, self.settings)
            decision = self.agent.decide(
                state=initial,
                optimization=optimization,
                diagnostic=analysis.diagnostic,
            )

            twin = DigitalTwin(initial)
            apply_decision(twin, decision, optimization)

            post_move_power = estimate_power(twin.state, self.settings).expected_power_w
            dt_min = self.settings.simulation_step_min if step_minutes is None else float(step_minutes)
            dt_h = dt_min / 60.0

            generated_wh = post_move_power * dt_h
            consumed_wh = self.settings.base_load_w * dt_h
            motor_cost_wh = optimization.best.motor_cost_wh if decision.action == "MOVE" else 0.0
            battery_delta_wh = generated_wh - consumed_wh - motor_cost_wh

            twin.apply_energy_delta(
                energy_delta_wh=battery_delta_wh,
                battery_capacity_wh=self.settings.battery_capacity_wh,
            )
            twin.set_observed_power(post_move_power)
            twin.advance_time(dt_min)
            updated = self.store.replace(twin.state)

            return CycleResult(
                initial_state=initial,
                analysis=analysis,
                optimization=optimization,
                decision=decision,
                updated_state=updated,
                post_move_power_w=post_move_power,
            )
