from backend.app.core.contracts import CandidateAction, DiagnosticResult, OptimizationResult
from backend.app.modules.llm_agent.agent import SolarNavAgent


def make_optimization(state, gain):
    current = CandidateAction(tilt_deg=state.panel.tilt_deg, azimuth_deg=state.panel.azimuth_deg, predicted_power_w=500, solar_energy_wh=250, motor_cost_wh=0, net_energy_wh=250)
    best = CandidateAction(tilt_deg=45, azimuth_deg=140, predicted_power_w=600, solar_energy_wh=300, motor_cost_wh=1, net_energy_wh=250+gain)
    return OptimizationResult(horizon_minutes=30, current=current, best=best, net_gain_wh=gain)


def test_agent_move_and_hold_threshold(twin_state, test_settings):
    diagnostic = DiagnosticResult(status="OK", performance_gap_pct=0, message="ok")
    agent = SolarNavAgent(test_settings)
    move = agent.decide(state=twin_state, optimization=make_optimization(twin_state, test_settings.min_move_gain_wh+1), diagnostic=diagnostic)
    assert move.action == "MOVE" and move.target_tilt_deg == 45
    hold = agent.decide(state=twin_state, optimization=make_optimization(twin_state, test_settings.min_move_gain_wh-.1), diagnostic=diagnostic)
    assert hold.action == "HOLD" and hold.target_tilt_deg == twin_state.panel.tilt_deg


class FailingProvider:
    source_name = "nvidia_nim"
    def explain(self, **kwargs):
        raise RuntimeError("simulated provider outage")


def test_agent_falls_back_when_llm_provider_fails(twin_state, test_settings):
    diagnostic = DiagnosticResult(status="OK", performance_gap_pct=0, message="ok")
    agent = SolarNavAgent(test_settings, provider=FailingProvider())
    decision = agent.decide(
        state=twin_state,
        optimization=make_optimization(twin_state, test_settings.min_move_gain_wh + 1),
        diagnostic=diagnostic,
    )
    assert decision.action == "MOVE"
    assert decision.explanation_source == "fallback"
    assert decision.reason
