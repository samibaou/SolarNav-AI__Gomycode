/* =========================================================================
   datasource.js — point d'integration de SolarNav

   Le tableau de bord ne simule rien. Il consomme des trames de telemetrie
   produites ailleurs, selon le contrat ci-dessous.

   ------------------------------------------------------------------ TRAME
   {
     t:              1738072800000,  // ms epoch (ou index croissant)
     sun_elevation:  42.3,           // deg, -90..90        REQUIS
     sun_azimuth:    170.0,          // deg, 0..360         REQUIS
     is_sunlit:      true,           // booleen             REQUIS
     dust_level:     12.5,           // %, 0..100           REQUIS
     surface_temp:   68.0,           // degres C            REQUIS

     angle_optimal:   47.8,          // deg, verite physique      optionnel
     angle_predicted: 47.6,          // deg, sortie du modele     optionnel
     uncertainty:      0.4,          // deg (+/-)                 optionnel
     applied_angle:   47.6,          // deg reellement applique   optionnel
     power_w:          312,          // W mesures                 optionnel
     satellite:      'ISS'           // libelle de la source      optionnel
   }

   -------------------------------------------------------------- SOURCES
   Trois facons d'alimenter le tableau de bord, essayees dans cet ordre :

   1. PUSH      window.SolarNav.push(trame)   — appel direct depuis votre code
   2. API       GET /api/telemetry            — interrogee toutes les secondes
   3. REJEU     data/telemetry.json           — fichier de trames, relu en boucle

   Sans aucune des trois, le tableau de bord affiche un etat d'attente et
   les curseurs manuels restent utilisables pour interroger le modele.
   ========================================================================= */

import { FEATURE_KEYS, validate, clamp } from './model.js';

const API_TELEMETRY = 'api/telemetry';
const API_PREDICT = 'api/predict';
const REPLAY_FILE = 'data/telemetry.json';

/* ----------------------------------------------------- NORMALISATION */

const bool = v => v === true || v === 1 || v === '1' || v === 'true';

/** Accepte quelques variantes d'ecriture et renvoie une trame canonique. */
export function normalize(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (...names) => {
    for (const n of names) if (raw[n] !== undefined && raw[n] !== null) return raw[n];
    return undefined;
  };

  const f = {
    t: Number(pick('t', 'time', 'timestamp', 'ts')) || index,
    sun_elevation: Number(pick('sun_elevation', 'elevation', 'sunElevation')),
    sun_azimuth: Number(pick('sun_azimuth', 'azimuth', 'sunAzimuth')),
    is_sunlit: bool(pick('is_sunlit', 'sunlit', 'isSunlit')),
    dust_level: Number(pick('dust_level', 'dust', 'dustLevel')),
    surface_temp: Number(pick('surface_temp', 'temp', 'temperature', 'surfaceTemp')),
    angle_optimal: num(pick('angle_optimal', 'optimal', 'target')),
    angle_predicted: num(pick('angle_predicted', 'predicted', 'prediction')),
    uncertainty: num(pick('uncertainty', 'sigma', 'std')),
    applied_angle: num(pick('applied_angle', 'applied', 'tilt')),
    power_w: num(pick('power_w', 'power', 'watts')),
    satellite: pick('satellite', 'source', 'name')
  };
  f.issues = validate(f);
  return f;
}

const num = v => (v === undefined || v === null || !isFinite(Number(v)) ? undefined : Number(v));

/** Extrait le vecteur d'entree du modele, dans l'ordre attendu. */
export const featureVector = f => ({
  sun_elevation: f.sun_elevation,
  sun_azimuth: f.sun_azimuth,
  is_sunlit: f.is_sunlit ? 1 : 0,
  dust_level: f.dust_level,
  surface_temp: f.surface_temp
});

/* ============================== SOURCE ============================== */

export function createDataSource({ onFrame, onStatus }) {
  const state = {
    mode: 'idle',          // idle | push | api | replay
    label: 'en attente',
    running: false,
    speed: 1,
    replay: [],
    cursor: 0,
    lastError: null,
    detected: false        // la detection initiale est terminee
  };

  let timer = null;
  let apiFailures = 0;

  const status = () => onStatus?.({ ...state });

  function emit(frame) {
    if (!frame) return;
    onFrame?.(frame);
  }

  /* ---------- 1. push direct ---------- */
  function push(raw) {
    const f = normalize(raw, Date.now());
    if (!f) return false;
    if (state.mode !== 'push') {
      stopTimer();
      state.mode = 'push';
      state.label = 'injection directe';
      state.running = true;
      status();
    }
    emit(f);
    return true;
  }

  /* ---------- 2. interrogation de l'API ---------- */
  async function pollApi() {
    try {
      const r = await fetch(API_TELEMETRY, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.frames || (j.frame ? [j.frame] : [j]));
      let n = 0;
      for (const raw of list) { const f = normalize(raw, Date.now()); if (f) { emit(f); n++; } }
      apiFailures = 0;
      return n > 0;
    } catch (e) {
      apiFailures++;
      state.lastError = e.message;
      if (apiFailures >= 3 && state.mode === 'api') {
        // l'API a disparu : on retente le rejeu s'il est disponible
        stopTimer();
        state.mode = 'idle'; state.label = 'source perdue'; state.running = false;
        status();
      }
      return false;
    }
  }

  /* ---------- 3. rejeu d'un fichier ---------- */
  async function loadReplay() {
    try {
      const r = await fetch(REPLAY_FILE, { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.frames || []);
      state.replay = list.map((raw, i) => normalize(raw, i)).filter(Boolean);
      return state.replay.length > 1;
    } catch { return false; }
  }

  function stepReplay() {
    if (!state.replay.length) return;
    emit(state.replay[state.cursor]);
    state.cursor = (state.cursor + 1) % state.replay.length;
  }

  /* ---------- boucle ---------- */
  function stopTimer() { clearInterval(timer); timer = null; }

  function startTimer() {
    stopTimer();
    const period = state.mode === 'api' ? 1000 : Math.max(60, 500 / state.speed);
    timer = setInterval(() => {
      if (!state.running) return;
      if (state.mode === 'api') pollApi();
      else if (state.mode === 'replay') stepReplay();
    }, period);
  }

  /* ---------- detection au demarrage ---------- */
  async function detect() {
    state.label = 'détection de la source…';
    status();

    if (await pollApi()) {
      state.mode = 'api';
      state.label = 'API /api/telemetry';
      state.running = true;
      state.detected = true;
      startTimer(); status();
      return;
    }

    if (await loadReplay()) {
      state.mode = 'replay';
      state.label = `rejeu · ${state.replay.length} trames`;
      state.running = false;                 // le rejeu demarre sur action
      state.detected = true;
      status();
      emit(state.replay[0]);
      return;
    }

    state.mode = 'idle';
    state.label = 'aucune source — curseurs manuels actifs';
    state.running = false;
    state.detected = true;
    status();
  }

  /* ---------- commandes ---------- */
  const api = {
    push,
    state: () => ({ ...state }),
    start() {
      if (state.mode === 'idle' || state.mode === 'push') return false;
      state.running = true; startTimer(); status(); return true;
    },
    pause() { state.running = false; stopTimer(); status(); },
    toggle() { return state.running ? (api.pause(), false) : api.start(); },
    setSpeed(s) { state.speed = s; if (state.running) startTimer(); status(); },
    reset() {
      state.cursor = 0;
      if (state.mode === 'replay' && state.replay.length) emit(state.replay[0]);
      status();
    },
    seek(ratio) {
      if (state.mode !== 'replay' || !state.replay.length) return;
      state.cursor = clamp(Math.round(ratio * (state.replay.length - 1)), 0, state.replay.length - 1);
      emit(state.replay[state.cursor]);
    },
    progress: () => (state.replay.length ? state.cursor / (state.replay.length - 1) : 0),
    retry: detect
  };

  detect();

  // point d'entree public pour le code externe
  window.SolarNav = window.SolarNav || {};
  window.SolarNav.push = push;
  window.SolarNav.source = api;

  return api;
}

/* ============================= PREDICTEUR ============================= */

/**
 * Obtient l'angle recommande pour une trame.
 * Ordre de preference :
 *   1. la trame contient deja `angle_predicted` (la source a fait tourner le modele) ;
 *   2. POST /api/predict (model.joblib servi par app.py) ;
 *   3. repli sur la formule simple, clairement signale comme tel.
 */
export function createPredictor({ onStatus }) {
  let available = null;          // null = inconnu, true/false ensuite
  let inflight = false;
  let lastKey = '';
  let lastResult = null;

  const key = v => FEATURE_KEYS.map(k => Math.round(Number(v[k]) * 10)).join('|');

  async function predict(frame) {
    if (isFinite(frame.angle_predicted)) {
      return {
        tilt: frame.angle_predicted,
        uncertainty: frame.uncertainty,
        source: 'source amont',
        confident: true
      };
    }
    if (available === false) return null;

    const v = featureVector(frame);
    const k = key(v);
    if (k === lastKey && lastResult) return lastResult;
    if (inflight) return lastResult;

    inflight = true;
    try {
      const r = await fetch(API_PREDICT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v)
      });
      if (r.status === 422) {                       // entrees refusees par le modele
        const j = await r.json();
        lastKey = k;
        lastResult = { rejected: true, detail: j.detail || 'entrées hors domaine', source: 'modèle' };
        available = true;
        return lastResult;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      available = true;
      lastKey = k;
      lastResult = {
        tilt: Number(j.tilt),
        uncertainty: isFinite(j.uncertainty) ? Number(j.uncertainty) : undefined,
        source: j.source || 'model.joblib',
        confident: j.confident !== false
      };
      onStatus?.({ available: true, source: lastResult.source });
      return lastResult;
    } catch {
      if (available === null) {
        available = false;
        onStatus?.({ available: false, source: 'formule simple (modèle non joignable)' });
      }
      return null;
    } finally {
      inflight = false;
    }
  }

  return { predict, isAvailable: () => available };
}

/* ============================== METRIQUES ============================== */

/** Charge data/metrics.json si l'equipe modele l'a depose. */
export async function loadMetrics(fallback) {
  try {
    const r = await fetch('data/metrics.json', { cache: 'no-store' });
    if (!r.ok) return fallback;
    const j = await r.json();
    return { ...fallback, ...j, source: 'data/metrics.json' };
  } catch { return fallback; }
}
