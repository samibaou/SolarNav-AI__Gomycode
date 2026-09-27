// SolarNav — adaptateur HTTP vers le backend FastAPI (contrat unique : contracts.py côté serveur, docs/API_CONTRACT.md).
// Le twin ne parle au backend que par HTTP/JSON, en URL relative (/api/v1) : la page est servie par uvicorn.
// Conversions faites ici et seulement ici :
//   - W → kW, uniquement pour l'affichage ;
//   - dust_factor (1 = propre) → dustPct (0 = propre) ;
//   - Decision (une seule, pour la station) → une décision par panneau (4 panneaux), avec son `reason`.
// Angles : identiques des deux côtés (tilt depuis l'horizontale, azimut boussole de la normale, 0 = N, 90 = E).

const BACKEND_BASE = '/api/v1';
const BACKEND_ACTIONS = ['MOVE', 'HOLD', 'STOW'];
const W_PER_KW = 1000;
// Désaccord physique / ML au-delà duquel la décision est marquée à risque (écart relatif).
const PHYSICS_ML_MISMATCH_RATIO = 0.25;

function createBackendClient(base = BACKEND_BASE) {
  return {
    base, timeoutMs: 5000,
    // Page en file:// : une URL relative ne peut pas atteindre le backend (aucune requête n'est tentée).
    available() {
      return /^https?:/i.test(this.base) || (typeof location !== 'undefined' && /^https?:$/.test(location.protocol));
    },
    async request(path, { method = 'GET' } = {}) {
      if (!this.available()) throw new Error('backend indisponible (page ouverte en file://)');
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.base + path, { method, signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(`timeout (${this.timeoutMs} ms)`);
        if (e instanceof TypeError) throw new Error('backend injoignable (' + e.message + ')');
        throw e;
      } finally { clearTimeout(timer); }
    },
    // POST /agent/decision : décision du backend sur SON état (TwinState), sans corps.
    async decision() { return validateBackendDecision(await this.request('/agent/decision', { method: 'POST' })); },
    // GET /analysis : physique + ML + diagnostic (lecture seule).
    analysis() { return this.request('/analysis'); },
    // GET /state : TwinState canonique.
    state() { return this.request('/state'); },
  };
}

// Decision (contracts.py) : { action, target_tilt_deg, target_azimuth_deg, reason, explanation_source }.
function validateBackendDecision(d) {
  if (!d || typeof d !== 'object') throw new Error('réponse invalide : objet Decision attendu');
  if (!BACKEND_ACTIONS.includes(d.action)) throw new Error(`action invalide (${d.action})`);
  for (const f of ['target_tilt_deg', 'target_azimuth_deg'])
    if (typeof d[f] !== 'number' || !Number.isFinite(d[f])) throw new Error(`${f} invalide`);
  return d;
}

// Une Decision backend → une décision par panneau (format interne du twin, voir decision.js).
function panelDecisionsFromBackend(d, state) {
  const az = ((d.target_azimuth_deg % 360) + 360) % 360;
  return state.panels.map(p => ({
    panelId: p.panelId, action: d.action,
    targetTilt: d.action === 'HOLD' ? p.tiltDeg : d.target_tilt_deg,
    targetAzimuth: d.action === 'HOLD' ? p.azimuthDeg : d.action === 'STOW' ? p.azimuthDeg : az,
    expectedGainKW: null, uncertainty: null, riskFlags: [],
    reason: d.reason || '', explanationSource: d.explanation_source || null, source: 'ai',
  }));
}

// AnalysisBundle → drapeaux de risque et incertitude (1 − confiance du modèle ML).
function analysisSignals(a) {
  if (!a) return { flags: [], uncertainty: null };
  const flags = [];
  const phys = a.physics?.expected_power_w, ml = a.ml?.predicted_power_w;
  if (typeof phys === 'number' && typeof ml === 'number' && Math.max(phys, ml) > 50
      && Math.abs(phys - ml) / Math.max(phys, ml) > PHYSICS_ML_MISMATCH_RATIO) flags.push('PHYSICS_ML_MISMATCH');
  if (a.diagnostic?.status === 'ANOMALY') flags.push('DIAGNOSTIC_ALERT');
  const conf = a.ml?.confidence;
  return { flags, uncertainty: typeof conf === 'number' ? +(1 - conf).toFixed(3) : null };
}

// TwinState → valeurs d'affichage (kW, dustPct).
function twinStateView(ts) {
  return {
    timestamp: ts.timestamp,
    sunElevDeg: ts.sun.elevation_deg, sunAzimuthDeg: ts.sun.azimuth_deg,
    panelTiltDeg: ts.panel.tilt_deg, panelAzimuthDeg: ts.panel.azimuth_deg,
    socPct: ts.battery.soc_pct,
    dustPct: (1 - ts.environment.dust_factor) * 100,
    observedKW: ts.energy.observed_power_w == null ? null : ts.energy.observed_power_w / W_PER_KW,
  };
}
