const API_BASE = "/api/v1";

export function assertTwinStateShape(state) {
  const required = ["timestamp", "sun", "panel", "battery", "environment", "energy"];
  for (const key of required) {
    if (!(key in state)) throw new Error(`Invalid TwinState: missing ${key}`);
  }
  if (typeof state.sun.azimuth_deg !== "number") throw new Error("Invalid sun.azimuth_deg");
  if (typeof state.panel.tilt_deg !== "number") throw new Error("Invalid panel.tilt_deg");
  if (typeof state.battery.soc_pct !== "number") throw new Error("Invalid battery.soc_pct");
  return state;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

export async function health() {
  const response = await fetch("/health");
  if (!response.ok) throw new Error("API health check failed");
  return response.json();
}

export async function getState() { return assertTwinStateShape(await request("/state")); }
export async function resetState(payload) {
  return assertTwinStateShape(await request("/state/reset", { method: "POST", body: JSON.stringify(payload) }));
}
export async function runCycle(stepMinutes = null) {
  const body = stepMinutes == null ? {} : { step_minutes: stepMinutes };
  return request("/simulation/cycle", { method: "POST", body: JSON.stringify(body) });
}
export async function getDecision() { return request("/agent/decision", { method: "POST" }); }
