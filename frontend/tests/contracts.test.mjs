import assert from "node:assert/strict";
import test from "node:test";
import { assertTwinStateShape } from "../js/api.js";

const validState = {
  timestamp: "2026-09-27T12:00:00Z",
  sun: { azimuth_deg: 142, elevation_deg: 4.8 },
  panel: { tilt_deg: 32, azimuth_deg: 120 },
  battery: { soc_pct: 41 },
  environment: { illumination: .88, shadow_probability: .15, dust_factor: .95 },
  energy: { observed_power_w: 400 }
};

test("frontend accepts backend TwinState contract", () => {
  assert.equal(assertTwinStateShape(validState), validState);
});

test("frontend rejects incomplete TwinState", () => {
  const broken = structuredClone(validState); delete broken.panel;
  assert.throws(() => assertTwinStateShape(broken), /missing panel/);
});
