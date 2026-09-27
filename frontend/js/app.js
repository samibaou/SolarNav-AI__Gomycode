import { getState, health, resetState, runCycle } from "./api.js";
import { renderCycle, renderState } from "./dashboard.js";
import { initDigitalTwin } from "../digital_twin/scene.js";

const apiStatus = document.getElementById("api-status");
const cycleBtn = document.getElementById("cycle-btn");
const refreshBtn = document.getElementById("refresh-btn");
const form = document.getElementById("scenario-form");
const twinRenderer = await initDigitalTwin(document.getElementById("twin-stage"));

async function updateState() {
  const state = await getState();
  renderState(state); twinRenderer.update(state); return state;
}

async function boot() {
  try { await health(); apiStatus.textContent = "API online"; await updateState(); }
  catch (error) { apiStatus.textContent = "API error"; console.error(error); }
}

refreshBtn.addEventListener("click", updateState);
cycleBtn.addEventListener("click", async () => {
  cycleBtn.disabled = true;
  try { const result = await runCycle(); renderCycle(result); twinRenderer.update(result.updated_state); }
  catch (error) { console.error(error); alert(error.message); }
  finally { cycleBtn.disabled = false; }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    timestamp: new Date().toISOString(),
    sun_azimuth_deg: Number(document.getElementById("in-sun-az").value),
    sun_elevation_deg: Number(document.getElementById("in-sun-el").value),
    panel_azimuth_deg: Number(document.getElementById("in-panel-az").value),
    panel_tilt_deg: Number(document.getElementById("in-panel-tilt").value),
    battery_soc_pct: Number(document.getElementById("in-battery").value),
    illumination: Number(document.getElementById("in-illumination").value),
    shadow_probability: Number(document.getElementById("in-shadow").value),
    dust_factor: Number(document.getElementById("in-dust").value),
    observed_power_w: null
  };
  try { const state = await resetState(payload); renderState(state); twinRenderer.update(state); }
  catch (error) { console.error(error); alert(error.message); }
});

await boot();
