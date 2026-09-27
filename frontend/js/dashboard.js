function text(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

export function renderState(state) {
  text("battery", `${state.battery.soc_pct.toFixed(1)}%`);
  const p = state.energy.observed_power_w;
  text("power", p == null ? "n/a" : `${p.toFixed(1)} W`);
  text("tilt", `${state.panel.tilt_deg.toFixed(1)}°`);
  text("azimuth", `${state.panel.azimuth_deg.toFixed(1)}°`);

  const fields = {
    "in-sun-az": state.sun.azimuth_deg,
    "in-sun-el": state.sun.elevation_deg,
    "in-panel-az": state.panel.azimuth_deg,
    "in-panel-tilt": state.panel.tilt_deg,
    "in-battery": state.battery.soc_pct,
    "in-illumination": state.environment.illumination,
    "in-shadow": state.environment.shadow_probability,
    "in-dust": state.environment.dust_factor
  };
  for (const [id, value] of Object.entries(fields)) {
    const node = document.getElementById(id);
    if (node) node.value = value;
  }
}

export function renderCycle(result) {
  text("decision-action", result.decision.action);
  text("target-tilt", `${result.decision.target_tilt_deg.toFixed(1)}°`);
  text("target-azimuth", `${result.decision.target_azimuth_deg.toFixed(1)}°`);
  text("net-gain", `${result.optimization.net_gain_wh.toFixed(2)} Wh`);
  text("diagnostic", result.analysis.diagnostic.status);
  text("reason", result.decision.reason);
  renderState(result.updated_state);
}
