// SolarNav — fournisseur de décision. Format détaillé dans CONTRACT.md.
//   decideLocal(state) → Decision[]                    (une décision par panneau, politique locale)
//   decisionProvider.current(state) → Decision[]       (proposition à passer à la porte de validation, js/gate.js)
//   Decision = { panelId, action: 'MOVE'|'HOLD'|'STOW', targetTilt, targetAzimuth, expectedGainKW, uncertainty,
//                riskFlags: [], reason, source: 'ai'|'fallback'|'override', explanationSource? }
// Modes : 'local' (politique ci-dessous, source 'fallback') ou 'api' (POST /api/v1/agent/decision via js/backend.js).
// La décision du backend porte sur SON état : elle n'est appliquée qu'en source de données Live ; sinon repli local signalé.
// Angles : targetTilt en degrés depuis l'horizontale, targetAzimuth = azimut boussole de la normale du panneau (0 N, 90 E, 180 S).

const DECISION_ACTIONS = ['MOVE', 'HOLD', 'STOW'];
const DECISION_SCHEMA_VERSION = '1.1';
const D2R = Math.PI / 180;
// Dangers pour lesquels la politique locale de sécurité prime sur toute autre source (y compris le backend).
const SAFETY_FLAGS = ['HIGH_WIND', 'HAIL', 'SPACE_WEATHER', 'NIGHT', 'SNOW'];
const SNOW_SHED_TILT_DEG = 60;        // inclinaison forte : la neige glisse
const DIFFUSE_TILT_DEG = 12;          // lumière surtout diffuse : panneaux presque à plat, face au ciel
const DIFFUSE_SHARE = 0.7;
const HIGH_TEMP_C = 65, DUSTY_PCT = 30;

const fmt = (v, d = 0) => Number(v).toFixed(d).replace('.', ',');

// Cosinus de l'angle d'incidence entre la normale du panneau (tilt, azimut) et le soleil (élévation, azimut).
function incidenceFromAngles(tiltDeg, azDeg, sunElevDeg, sunAzDeg) {
  const t = tiltDeg * D2R, a = azDeg * D2R, e = sunElevDeg * D2R, s = sunAzDeg * D2R;
  const n = [Math.sin(t) * Math.sin(a), Math.cos(t), Math.sin(t) * Math.cos(a)];
  const v = [Math.cos(e) * Math.sin(s), Math.sin(e), Math.cos(e) * Math.cos(s)];
  return Math.max(0, n[0] * v[0] + n[1] * v[1] + n[2] * v[2]);
}

// Production attendue d'un panneau (kW) pour une orientation donnée, à partir de l'état — même modèle que la simulation.
function expectedPanelKW(state, panel, tiltDeg, azDeg) {
  const { sun, weather, model } = state;
  if (sun.elevationDeg <= 0) return 0;
  const inc = incidenceFromAngles(tiltDeg, azDeg, sun.elevationDeg, sun.azimuthDeg), c = Math.cos(tiltDeg * D2R);
  const poa = weather.dniWm2 * inc + weather.dhiWm2 * (1 + c) / 2 + weather.ghiWm2 * weather.albedo * (1 - c) / 2;
  const cell = weather.ambientC + (model.noctC - 20) / 800 * poa * 9.5 / (5.7 + 3.8 * weather.windMs);
  const tempF = model.thermalLosses ? 1 + model.tempCoefPerC * (cell - 25) : 1;
  const dustF = 1 - model.dustMaxLoss * panel.dustPct / 100;
  const snowF = 1 - (panel.snowPct || 0) / 100;
  return Math.min(panel.capacityKW, panel.capacityKW * poa / 1000 * tempF * dustF * snowF);
}

// Politique locale : suivi solaire 2 axes, adapté aux conditions, avec mises en sécurité. Priorité :
// vent fort (à plat) > grêle (inclinaison max, protège le verre) > tempête solaire (à plat) > nuit (à plat)
// > neige (inclinaison forte) > lumière diffuse (presque à plat) > suivi du soleil.
function decideLocal(state) {
  const { sun, weather, constraints } = state;
  const sw = state.spaceWeather, cond = weather.condition || null;
  const diffuseShare = weather.ghiWm2 > 20 ? weather.dhiWm2 / weather.ghiWm2 : 0;
  const trackTilt = Math.min(constraints.tiltMaxDeg, Math.max(constraints.tiltMinDeg, 90 - sun.elevationDeg));
  return state.panels.map(p => {
    const riskFlags = [];
    if (sun.elevationDeg <= constraints.minSunElevDeg) riskFlags.push('NIGHT');
    if (weather.windMs >= constraints.windStowMs) riskFlags.push('HIGH_WIND');
    if (weather.hail) riskFlags.push('HAIL');
    if (sw && (sw.riskFlags || []).includes('SPACE_WEATHER')) riskFlags.push('SPACE_WEATHER');
    if ((p.snowPct || 0) > 5) riskFlags.push('SNOW');
    if (p.cellTempC > HIGH_TEMP_C) riskFlags.push('HIGH_TEMP');
    if (p.dustPct > DUSTY_PCT) riskFlags.push('DUSTY');
    if (state.sensors.some(s => s.panelId === p.panelId && s.status === 'FAULT')) riskFlags.push('SENSOR_FAULT');
    const has = f => riskFlags.includes(f);
    let action = 'MOVE', targetTilt = trackTilt, targetAzimuth = sun.azimuthDeg, reason;
    if (has('HIGH_WIND')) {
      action = 'STOW'; targetTilt = constraints.stowTiltDeg; targetAzimuth = p.azimuthDeg;
      reason = `Vent ${fmt(weather.windMs, 1)} m/s ≥ ${constraints.windStowMs} m/s : mise en sécurité à plat` + (cond === 'sand' ? ' (tempête de sable).' : '.');
    } else if (has('HAIL')) {
      action = 'STOW'; targetTilt = constraints.tiltMaxDeg; targetAzimuth = p.azimuthDeg;
      reason = `Grêle : inclinaison maximale ${constraints.tiltMaxDeg}° pour protéger le verre des impacts.`;
    } else if (has('SPACE_WEATHER')) {
      action = 'STOW'; targetTilt = constraints.stowTiltDeg; targetAzimuth = p.azimuthDeg;
      reason = 'Tempête solaire forte : mise en sécurité à plat.' + (sw?.reasons?.length ? ` (${sw.reasons.join(', ')})` : '');
    } else if (has('NIGHT')) {
      action = 'STOW'; targetTilt = constraints.stowTiltDeg; targetAzimuth = p.azimuthDeg;
      reason = `Soleil à ${fmt(sun.elevationDeg, 1)}°, sous le seuil de ${constraints.minSunElevDeg}° du site : mise à plat.`;
    } else if (has('SNOW')) {
      targetTilt = Math.min(constraints.tiltMaxDeg, SNOW_SHED_TILT_DEG);
      reason = `Neige (${fmt(p.snowPct)} % du panneau couvert) : inclinaison forte à ${targetTilt}° pour évacuer la neige.`;
    } else if (diffuseShare > DIFFUSE_SHARE) {
      targetTilt = Math.min(trackTilt, DIFFUSE_TILT_DEG);
      reason = `Rayonnement surtout diffus (${fmt(diffuseShare * 100)} %)` + (cond === 'fog' ? ', brouillard' : cond === 'rain' ? ', pluie' : '') +
        ` : panneaux presque à plat (${fmt(targetTilt)}°), face au ciel.`;
    } else if (cond === 'rain') {
      reason = 'Pluie : suivi solaire maintenu, nettoyage naturel des panneaux en cours.';
    }
    const now = expectedPanelKW(state, p, p.tiltDeg, p.azimuthDeg);
    const expectedGainKW = expectedPanelKW(state, p, targetTilt, targetAzimuth) - now;
    if (!reason) reason = `Suivi solaire 2 axes : gain attendu ${expectedGainKW >= 0 ? '+' : ''}${fmt(expectedGainKW, 2)} kW.`;
    if (has('HIGH_TEMP')) reason += ` Cellules à ${fmt(p.cellTempC)} °C : perte thermique ${fmt(-state.model.tempCoefPerC * (p.cellTempC - 25) * 100)} %.`;
    if (has('DUSTY')) reason += ` Poussière ${fmt(p.dustPct)} % : nettoyage recommandé.`;
    const cf = weather.cloudFactor ?? 1;
    return { panelId: p.panelId, action, targetTilt, targetAzimuth, expectedGainKW,
      uncertainty: +(0.05 + 0.3 * (1 - cf)).toFixed(3), riskFlags, reason, source: 'fallback' };
  });
}

// Décisions d'une autre source (backend) + sécurité locale : un danger local (vent, grêle, tempête solaire, nuit, neige)
// remplace la décision du panneau ; sinon les drapeaux informatifs locaux sont ajoutés.
function withLocalSafety(local, decisions) {
  return decisions.map(d => {
    const l = local.find(x => x.panelId === d.panelId);
    if (!l) return d;
    if (l.riskFlags.some(f => SAFETY_FLAGS.includes(f))) return l;
    return { ...d, riskFlags: [...new Set([...d.riskFlags, ...l.riskFlags])] };
  });
}

function createDecisionProvider(client = createBackendClient()) {
  return {
    mode: 'local',                                   // 'local' | 'api'
    client,
    periodMs: 5000, maxAgeMs: 15000,
    latest: null,                                    // { decision, analysis, receivedAt } — dernière réponse backend valide
    inFlight: false, lastRequestAt: -Infinity, lastError: null, lastLatencyMs: null, okCount: 0, failCount: 0,
    warning: null,                                   // repli local volontaire (source ≠ Live), affiché dans l'UI

    // Proposition du backend applicable à cet état ? (mode api, source Live, réponse récente)
    backendUsable(state) {
      if (this.mode !== 'api') { this.warning = null; return false; }
      const live = state.dataSource.mode === 'live' && state.dataSource.status === 'ok';
      this.warning = live ? null : 'Décision du backend ignorée : elle porte sur l’état du backend, appliquée seulement en source Live → repli local.';
      return live && !!this.latest && performance.now() - this.latest.receivedAt <= this.maxAgeMs;
    },

    // Décisions proposées maintenant (synchrone, appelé à chaque image) : backend si utilisable, sinon politique locale.
    current(state) {
      const local = decideLocal(state);
      if (!this.backendUsable(state)) return local;
      const { decision, analysis } = this.latest, sig = analysisSignals(analysis);
      const ai = panelDecisionsFromBackend(decision, state).map(d => {
        const p = state.panels.find(x => x.panelId === d.panelId);
        return { ...d, uncertainty: sig.uncertainty, riskFlags: [...sig.flags],
          expectedGainKW: p ? expectedPanelKW(state, p, d.targetTilt, d.targetAzimuth) - expectedPanelKW(state, p, p.tiltDeg, p.azimuthDeg) : null };
      });
      return withLocalSafety(local, ai);
    },

    // Appel du backend (au plus un en vol, cadence periodMs). Ne rejette jamais : une erreur laisse le repli local.
    async refresh() {
      const t0 = performance.now();
      try {
        const [decision, analysis] = await Promise.all([this.client.decision(), this.client.analysis().catch(() => null)]);
        this.lastLatencyMs = performance.now() - t0; this.lastError = null; this.okCount++;
        this.latest = { decision, analysis, receivedAt: performance.now() };
      } catch (e) {
        this.failCount++; this.lastError = e.message || String(e);
      }
    },
    tick(state) {
      if (this.mode !== 'api' || this.inFlight || performance.now() - this.lastRequestAt < this.periodMs) return;
      if (state.dataSource.mode !== 'live') return;   // inutile d'interroger le backend : sa décision serait ignorée
      this.inFlight = true; this.lastRequestAt = performance.now();
      this.refresh().finally(() => { this.inFlight = false; });
    },

    setMode(mode) { this.mode = mode; this.latest = null; this.lastError = null; this.warning = null; this.lastRequestAt = -Infinity; },
  };
}
