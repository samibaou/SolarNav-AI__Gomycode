/* =========================================================================
   app.js — tableau de bord SolarNav (lecture seule)

   Aucune commande : la page affiche ce que la source de telemetrie envoie
   (datasource.js), demande l'angle au modele (/api/predict), et se contente
   de montrer le resultat. Les evenements partent dans le journal partage,
   consultable sur journal.html.
   ========================================================================= */

import {
  FEATURES, DEG, clamp, fmt, clockLabel, simpleFormula, energyRatio,
  validate, DEFAULT_METRICS, DUST_LEVELS, TEMP_LEVELS, levelOf
} from './model.js';
import { createDataSource, createPredictor, loadMetrics } from './datasource.js';
import { createCharts, updateCharts, renderLegends, renderTable, drawSpark } from './charts.js';
import { appendLog, readLog, resetLog, LOG_MAX } from './log.js';
import { loadForecast, renderForecast } from './forecast.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const HISTORY = 240;          // points conserves dans les courbes
const PH = '<span class="ph">\u2014</span>';

/**
 * Ecrit une valeur numerique sans detruire l'unite (<small> ou <i>) ni le
 * marqueur d'absence. Un tiret cadratin affiche en 38 px de mono ressemble a
 * une barre pleine : l'etat vide a donc son propre style.
 */
function setVal(sel, text) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  const unit = el.querySelector('small, i');
  el.textContent = text;
  if (unit) el.appendChild(unit);
  el.classList.remove('is-empty');
}

const state = {
  frames: [],
  spark: [],
  metrics: DEFAULT_METRICS,
  charts: null,
  source: null,
  predictor: null,
  received: 0,
  rateWindow: [],
  last: null,
  lastLogged: null
};

/* ========================= INSTRUMENT : DOME ========================= */

const DOME = { cx: 180, cy: 178, r: 140 };

const domePoint = (theta, r = DOME.r) => ({
  x: DOME.cx - r * Math.cos(theta * DEG),
  y: DOME.cy - r * Math.sin(theta * DEG)
});

/** Angle ecran d'une direction, dans la coupe est-ouest. */
function screenAngle(elev, az) {
  const e = clamp(elev, -12, 90);
  const v = Math.sin(e * DEG);
  const h = Math.cos(e * DEG) * Math.cos((az - 270) * DEG);
  return Math.atan2(v, -h) / DEG;
}

function buildDomeTicks() {
  const g = $('#domeTicks');
  g.innerHTML = '';
  for (const th of [0, 30, 60, 90, 120, 150, 180]) {
    const a = domePoint(th, DOME.r), b = domePoint(th, DOME.r - 7);
    g.insertAdjacentHTML('beforeend', `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`);
    if (th % 30 === 0 && th !== 0 && th !== 180) {
      const t = domePoint(th, DOME.r - 17);
      g.insertAdjacentHTML('beforeend',
        `<text x="${t.x.toFixed(1)}" y="${(t.y + 3).toFixed(1)}" text-anchor="middle">${th <= 90 ? th : 180 - th}</text>`);
    }
  }
}

function updateDome(v) {
  const dome = $('#dome');
  const night = !v.is_sunlit || v.sun_elevation <= 0;
  dome.classList.toggle('is-night', night);

  const up = clamp(Math.sin(Math.max(v.sun_elevation, -3) * DEG), -0.2, 1);
  const d = night ? 0 : clamp(up * 3, 0, 1);
  $('#skyTop').setAttribute('stop-color', d > .5 ? '#bcdcf4' : (d > .12 ? '#8ea7c2' : '#6b7a8d'));
  $('#skyBottom').setAttribute('stop-color', d > .5 ? '#f3ecdd' : (d > .12 ? '#e8bf94' : '#9aa2ac'));

  const thSun = screenAngle(v.sun_elevation, v.sun_azimuth);
  const ps = domePoint(thSun);
  $('#sunMark').setAttribute('transform', `translate(${ps.x.toFixed(1)},${ps.y.toFixed(1)})`);
  $('#sunGlowC').setAttribute('opacity', night ? '.15' : '1');
  $('#sunRay').setAttribute('x2', ps.x.toFixed(1));
  $('#sunRay').setAttribute('y2', ps.y.toFixed(1));

  const thN = screenAngle(90 - v.applied, v.sun_azimuth);
  const pn = domePoint(thN, DOME.r - 26);
  $('#normalRay').setAttribute('x2', pn.x.toFixed(1));
  $('#normalRay').setAttribute('y2', pn.y.toFixed(1));
  $('#panelGroup').setAttribute('transform', `translate(${DOME.cx},${DOME.cy}) rotate(${(thN + 90).toFixed(2)})`);

  const thOpt = screenAngle(90 - v.optimal, v.sun_azimuth);
  const showGhost = v.optimal !== undefined && Math.abs(thOpt - thN) > 1.2;
  $('#targetPanel').setAttribute('transform', `translate(${DOME.cx},${DOME.cy}) rotate(${(thOpt + 90).toFixed(2)})`);
  $('#targetPanel').style.display = showGhost ? '' : 'none';

  const w = $('#aoiWedge');
  if (!night && Math.abs(thSun - thN) > 0.6) {
    const r = 62, a = domePoint(thN, r), b = domePoint(thSun, r);
    w.setAttribute('d', `M ${DOME.cx} ${DOME.cy} L ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 0 ${thSun > thN ? 0 : 1} ${b.x.toFixed(1)} ${b.y.toFixed(1)} Z`);
  } else w.setAttribute('d', '');
}

/* ======================= ENTREES DU MODELE ======================= */

/** Les deux entrees qui portent une echelle de severite coloree. */
const LEVELS_BY_KEY = {
  dust_level: { levels: DUST_LEVELS, domain: [0, 100], ticks: ['0', '15', '35', '60', '100 %'] },
  surface_temp: { levels: TEMP_LEVELS, domain: [-150, 160], ticks: ['-150', '-60', '40', '85', '160 °C'] }
};

function buildFeatureList() {
  $('#featList').innerHTML = FEATURES.map(f => {
    const lv = LEVELS_BY_KEY[f.key];

    // echelle de severite pour la poussiere et la temperature,
    // simple jauge de position pour les deux angles
    const gauge = f.bool ? '' : (lv ? `
      <span class="feat-scale">
        ${lv.levels.map(l => `<i style="background:${l.color}"></i>`).join('')}
        <em class="feat-cursor" data-cursor></em>
      </span>
      <span class="feat-ticks">${lv.ticks.map(t => `<span>${t}</span>`).join('')}</span>`
      : `
      <span class="feat-track"><em data-cursor></em></span>
      <span class="feat-ticks"><span>${f.min}${f.unit}</span><span>${f.max}${f.unit}</span></span>`);

    return `<div class="feat" data-feat="${f.key}">
      <span class="feat-h">${f.label} <code>${f.key}</code></span>
      <span class="feat-right"><b class="feat-v" data-v>—</b><i class="feat-lvl" data-lvl hidden></i></span>
      ${gauge}
      <span class="feat-hint">${f.hint}</span>
    </div>`;
  }).join('');
}

/**
 * Les entrees sont aussi les contraintes : empoussierement et temperature
 * portent leur echelle coloree la ou on les lit.
 */
function renderFeatures(v) {
  const issues = v.issues || [];
  let worst = null;

  for (const f of FEATURES) {
    const row = $(`.feat[data-feat="${f.key}"]`);
    if (!row) continue;
    const val = v[f.key];
    row.classList.toggle('is-bad', issues.some(i => i.key === f.key));

    row.querySelector('[data-v]').textContent = f.bool
      ? (val ? 'au soleil' : 'à l’ombre')
      : `${fmt(val, f.step < 1 ? 1 : 0)} ${f.unit}`.trim();

    if (f.bool) {
      const badge = row.querySelector('[data-lvl]');
      badge.hidden = false;
      badge.textContent = val ? 'exposé' : 'ombre';
      badge.style.background = val ? 'var(--sun-soft)' : 'var(--surface-3)';
      badge.style.color = val ? 'var(--sun-ink)' : 'var(--ink-3)';
      continue;
    }

    const cursor = row.querySelector('[data-cursor]');
    const lv = LEVELS_BY_KEY[f.key];
    const badge = row.querySelector('[data-lvl]');

    if (lv && isFinite(val)) {
      const level = levelOf(lv.levels, val);
      const sev = lv.levels.indexOf(level);
      badge.hidden = false;
      badge.textContent = level.label;
      badge.style.background = hexToRgba(level.color, .14);
      badge.style.color = level.color;
      const [lo, hi] = lv.domain;
      cursor.style.left = `${(clamp((val - lo) / (hi - lo), 0, 1) * 100).toFixed(1)}%`;
      if (!worst || sev > worst.sev) worst = { sev, level, feature: f };
    } else {
      badge.hidden = true;
      if (isFinite(val)) cursor.style.left = `${(clamp((val - f.min) / (f.max - f.min), 0, 1) * 100).toFixed(1)}%`;
    }
  }

  if (worst) $('#navEnvDot').style.background = worst.level.color;

  const ver = $('#inputsVerdict');
  ver.classList.remove('is-warn', 'is-bad');
  let icon = '#i-check', txt;

  if (issues.length) {
    txt = `${issues.length} entrée${issues.length > 1 ? 's' : ''} hors domaine : ` +
      issues.map(i => `${i.label} (${i.kind})`).join(', ') + '. Le modèle refuse de prédire.';
    ver.classList.add('is-bad'); icon = '#i-alert';
  } else if (!v.is_sunlit) {
    txt = 'À l’ombre : le modèle replie le panneau à 0°, il n’y a rien à viser.';
    ver.classList.add('is-warn'); icon = '#i-alert';
  } else if (worst && worst.sev >= 3) {
    txt = `${worst.feature.label} au niveau « ${worst.level.label.toLowerCase()} » — ${worst.level.advice}`;
    ver.classList.add(worst.sev >= 4 ? 'is-bad' : 'is-warn'); icon = '#i-alert';
  } else {
    txt = 'Les cinq entrées sont dans le domaine d’entraînement du modèle.';
  }
  ver.innerHTML = `<svg class="ic" viewBox="0 0 24 24"><use href="${icon}"/></svg><span>${txt}</span>`;

  $('#ioModel').textContent = v.predSource.startsWith('formule') ? 'formule' : 'modèle';
  $('#ioOut').textContent = `${fmt(v.predicted, 1)}°`;
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/* ========================= COULEUR DU CIEL ========================= */

/**
 * La carte « angle predit » et le bandeau du haut prennent la couleur du ciel
 * de l'instant : nuit profonde, rasance orangee, plein jour.
 */
const SKY_STOPS = {
  night: { top: [10, 16, 36], bot: [5, 7, 15], glow: [120, 140, 220, .10] },
  dawn: { top: [42, 46, 108], bot: [198, 92, 36], glow: [255, 158, 48, .52] },
  day: { top: [18, 54, 128], bot: [32, 96, 170], glow: [255, 202, 92, .32] }
};

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = c => `rgb(${c.slice(0, 3).map(Math.round).join(',')})`;
const rgba = c => `rgba(${c.slice(0, 3).map(Math.round).join(',')},${c[3].toFixed(2)})`;

function paintSky(v) {
  const s = SKY_STOPS;
  let top, bot, glow;

  if (!v.is_sunlit) {
    ({ top, bot } = s.night); glow = s.night.glow;
  } else {
    const t = clamp((v.sun_elevation + 8) / 10, 0, 1);
    const u = clamp((v.sun_elevation - 8) / 28, 0, 1);
    top = mix(mix(s.night.top, s.dawn.top, t), s.day.top, u);
    bot = mix(mix(s.night.bot, s.dawn.bot, t), s.day.bot, u);
    glow = mix(mix(s.night.glow, s.dawn.glow, t), s.day.glow, u);
  }

  const root = document.documentElement.style;
  root.setProperty('--sky-top', rgb(top));
  root.setProperty('--sky-bot', rgb(bot));
  root.setProperty('--sun-glow', rgba(glow));
  root.setProperty('--sky-pos', `${(clamp((v.sun_elevation + 15) / 105, 0, 1) * 100).toFixed(0)}%`);
}

/* ====================== PERFORMANCE DU MODELE ====================== */

function renderMetrics() {
  const m = state.metrics;
  const h = m.headline || {}, b = m.baseline || {}, g = m.generalisation || {};

  $('#perfGrid').innerHTML = `
    <div class="perf perf--hi"><span>Erreur moyenne</span><b>${fmt(h.mae_deg, 2)}°</b><em>sur données jamais vues</em></div>
    <div class="perf perf--hi"><span>Énergie récupérée</span><b>${fmt(h.energy_pct, 1)} %</b><em>du maximum théorique</em></div>
    <div class="perf"><span>R²</span><b>${fmt(h.r2, 3)}</b><em>plafond théorique ${fmt(g.theoretical_r2_ceiling ?? 0.9997, 4)}</em></div>
    <div class="perf perf--base"><span>Formule simple</span><b>${fmt(b.mae_deg, 1)}°</b><em>${fmt(h.speedup_vs_formula, 0)} fois moins précise</em></div>
    <div class="perf"><span>Entraînement / test</span><b>${fmt(g.train_mae_deg, 2)} / ${fmt(g.test_mae_deg, 2)}°</b><em>écart minime : pas d’apprentissage par cœur</em></div>
    <div class="perf"><span>Cibles mélangées</span><b>${fmt(g.shuffled_r2, 2)}</b><em>R² s’effondre : pas de fuite de données</em></div>`;

  $('#hardTable tbody').innerHTML = (m.hard_cases || []).map(c => {
    const factor = c.baseline / Math.max(c.model, 0.001);
    return `<tr><td>${c.case}</td><td class="good">${fmt(c.model, 2)}°</td><td>${fmt(c.baseline, 1)}°</td>` +
      `<td class="factor">×${fmt(factor, factor > 100 ? 0 : 1)}</td></tr>`;
  }).join('');

  $('#perfChecks').textContent = `${m.checks_passed ?? '—'} / ${m.checks_total ?? '—'} vérifications`;
  $('#perfSub').textContent = m.model ? `${m.model} · ${m.dataset || ''}` : 'Campagne de validation';
  $('#navR2').textContent = `R² ${fmt(h.r2, 3)}`;
  $('#aboutMetrics').textContent = m.source || 'valeurs par défaut';
}

/* ============================ JOURNAL ============================ */

const LOG_ICONS = { move: '#i-target', hold: '#i-pause', warn: '#i-alert', info: '#i-shield' };

function pushLog(kind, title, reason, t, deg = 0) {
  const list = appendLog({ kind, title, reason, t: t ?? Date.now(), deg });
  $('#navLogs').textContent = list.length;
  renderLastEvents(list);
}

function renderLastEvents(list = readLog()) {
  const el = $('#lastLog');
  if (!list.length) { el.innerHTML = '<li class="log-empty">Aucun évènement pour l’instant.</li>'; return; }
  el.innerHTML = list.slice(-4).reverse().map(d => `
    <li class="log-it" data-kind="${d.kind}">
      <span class="log-ic"><svg class="ic" viewBox="0 0 24 24"><use href="${LOG_ICONS[d.kind] || '#i-shield'}"/></svg></span>
      <span class="log-txt"><b>${d.title}</b><span>${d.reason}</span></span>
      <span class="log-t">${clockLabel(d.t).time}</span></li>`).join('');
}

/* ===================== TRAITEMENT D'UNE TRAME ===================== */

/** Enrichit une trame brute avec la prediction et les grandeurs derivees. */
async function enrich(raw) {
  const v = { ...raw };
  v.issues = validate(v);
  v.simple = simpleFormula(v.sun_elevation);

  const pred = await state.predictor.predict(v);

  if (pred?.rejected) {
    v.predicted = v.simple;
    v.predSource = 'entrées refusées par le modèle';
    v.rejected = pred.detail;
    v.confidence = 0;
  } else if (pred && isFinite(pred.tilt)) {
    v.predicted = pred.tilt;
    v.uncertainty = pred.uncertainty;
    v.predSource = pred.source;
    v.confidence = pred.uncertainty !== undefined ? clamp(1 - pred.uncertainty / 5, 0, 1) : 0.9;
  } else {
    v.predicted = v.simple;
    v.predSource = 'formule simple (modèle non joignable)';
    v.confidence = 0.35;
  }

  // a l'ombre, l'angle de repli est 0 par convention du modele
  if (!v.is_sunlit && !isFinite(raw.angle_predicted)) v.predicted = 0;

  v.applied = isFinite(raw.applied_angle) ? raw.applied_angle : v.predicted;
  v.optimal = isFinite(raw.angle_optimal) ? raw.angle_optimal : undefined;

  const ref = v.optimal !== undefined ? v.optimal : v.predicted;
  v.errModel = v.optimal !== undefined ? Math.abs(v.predicted - v.optimal) : undefined;
  v.errSimple = v.optimal !== undefined ? Math.abs(v.simple - v.optimal) : undefined;
  v.energy = v.is_sunlit ? energyRatio(v.applied, ref) : 0;
  v.delta = v.predicted - v.simple;
  return v;
}

/**
 * `enrich` attend le reseau : deux trames peuvent se chevaucher. Le jeton de
 * sequence garantit qu'un resultat perime n'ecrase jamais un plus recent.
 */
let seqCounter = 0;

async function onFrame(raw) {
  state.received++;
  state.rateWindow.push(Date.now());
  if (state.rateWindow.length > 20) state.rateWindow.shift();
  $('#sideFrames').textContent = state.received;

  const seq = ++seqCounter;
  const v = await enrich(raw);
  if (seq !== seqCounter) return;

  state.last = v;
  state.frames.push(v);
  if (state.frames.length > HISTORY) state.frames.shift();
  render(v);
}

/* ============================== RENDU ============================== */

let lastChartUpdate = 0;

function render(v) {
  const tl = clockLabel(v.t);
  $('#clockTime').textContent = tl.time;
  $('#clockDate').textContent = tl.sub;

  /* --- KPI --- */
  setVal('#kpiAngle', fmt(v.predicted, 1));
  $('#kpiAngleSub').innerHTML = `<svg class="ic" viewBox="0 0 24 24"><use href="#i-bolt"/></svg>` +
    (v.uncertainty !== undefined ? `± ${fmt(v.uncertainty, 2)}° · ${v.predSource}` : v.predSource);

  setVal('#kpiDelta', `${v.delta >= 0 ? '+' : ''}${fmt(v.delta, 1)}`);
  $('#kpiDeltaSub').innerHTML = `<svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>` +
    `formule simple : ${fmt(v.simple, 1)}°`;

  setVal('#kpiEnergy', fmt(v.energy * 100, 1));
  $('#kpiEnergySub').textContent = v.is_sunlit
    ? (v.optimal !== undefined ? 'par rapport à l’optimum physique' : 'par rapport à l’angle prédit')
    : 'à l’ombre : production nulle';

  // Quatrieme indicateur : l'erreur reelle si la source fournit l'optimum,
  // sinon la confiance que le modele accorde a sa propre prediction.
  const kq = $('#kpiQuality');
  if (v.errModel !== undefined) {
    $('#kpiQualityLbl').textContent = 'Erreur vs optimum';
    setVal(kq, fmt(v.errModel, 2));
    $('#kpiQualityUnit').textContent = '°';
    // sans modele branche, la prediction EST la formule : le rapport n'a pas de sens
    const gain = v.errSimple !== undefined && v.errModel > 0.01 ? v.errSimple / v.errModel : 1;
    const better = v.predSource.startsWith('formule')
      ? 'modèle non branché — c’est la formule qui prédit'
      : (gain > 1.15 ? `${fmt(gain, gain > 20 ? 0 : 1)}× mieux que la formule`
        : `formule simple : ${fmt(v.errSimple ?? 0, 2)}°`);
    $('#kpiQualitySub').innerHTML = `<svg class="ic" viewBox="0 0 24 24"><use href="#i-target"/></svg>${better}`;
    $('#qualityKpi').classList.toggle('kpi--alert', v.errModel > 3);
  } else {
    $('#kpiQualityLbl').textContent = 'Confiance du modèle';
    setVal(kq, fmt(v.confidence * 100, 0));
    $('#kpiQualityUnit').textContent = '%';
    $('#kpiQualitySub').innerHTML = `<svg class="ic" viewBox="0 0 24 24"><use href="#i-target"/></svg>` +
      (v.uncertainty !== undefined
        ? `± ${fmt(v.uncertainty, 2)}° donné par le modèle`
        : 'optimum non fourni par la source');
    $('#qualityKpi').classList.toggle('kpi--alert', v.confidence < 0.4);
  }

  /* --- HUD --- */
  $('#hudElev').textContent = `${fmt(v.sun_elevation, 1)}°`;
  $('#hudAz').textContent = `${fmt(v.sun_azimuth, 0)}°`;
  $('#hudTilt').textContent = `${fmt(v.applied, 1)}°`;
  const hudErr = $('#hudErr');
  hudErr.innerHTML = v.errModel !== undefined ? `${fmt(v.errModel, 2)}°` : PH;
  hudErr.className = v.errModel > 2 ? 'is-warn' : '';
  const hudT = $('#hudTemp');
  hudT.textContent = `${fmt(v.surface_temp, 0)} °C`;
  hudT.className = v.surface_temp > 100 ? 'is-bad' : (v.surface_temp < -60 ? 'is-warn' : '');
  const hudSun = $('#hudSun');
  hudSun.textContent = v.is_sunlit ? 'au soleil' : 'ombre';
  hudSun.className = v.is_sunlit ? 'is-accent' : 'is-warn';
  $('#twinTag').textContent = v.satellite || 'plateforme';

  /* --- lectures d'angles --- */
  setVal('#roTilt', fmt(v.predicted, 1));
  $('#roTiltSub').textContent = v.uncertainty !== undefined ? `± ${fmt(v.uncertainty, 2)}°` : 'incertitude non fournie';
  setVal('#roSimple', fmt(v.simple, 1));
  if (v.optimal !== undefined) setVal('#roOpt', fmt(v.optimal, 1));
  else { const o = $('#roOpt'); o.innerHTML = PH + '<i>°</i>'; o.classList.add('is-empty'); }
  $('#roOptSub').textContent = v.optimal !== undefined ? 'fourni par la source' : 'non fourni par la source';
  const loss = (1 - v.energy) * 100;
  setVal('#roLoss', fmt(loss, 2));
  $('#roLossSub').textContent = loss < 0.1 ? 'perte négligeable' : 'loi du cosinus';
  $('#navTilt').textContent = `${fmt(v.predicted, 0)}°`;
  $('#predSource').textContent = v.predSource;

  const conf = $('#confBar');
  conf.querySelector('i').style.width = `${(v.confidence * 100).toFixed(0)}%`;
  conf.className = 'conf-bar' + (v.confidence < 0.4 ? ' is-bad' : v.confidence < 0.7 ? ' is-warn' : '');
  $('#confLbl').textContent = v.rejected
    ? `entrées refusées : ${v.rejected}`
    : `confiance du modèle : ${(v.confidence * 100).toFixed(0)} %`;

  /* --- instruments --- */
  updateDome(v);
  renderFeatures(v);
  paintSky(v);

  /* --- bilan --- */
  const withTruth = state.frames.filter(f => f.errModel !== undefined);
  const mean = (arr, k) => arr.length ? arr.reduce((s, f) => s + f[k], 0) / arr.length : undefined;
  const maeM = mean(withTruth, 'errModel'), maeB = mean(withTruth, 'errSimple');
  $('#sumMaeModel').innerHTML = maeM !== undefined ? `${fmt(maeM, 2)}°` : PH;
  $('#sumMaeBase').innerHTML = maeB !== undefined ? `${fmt(maeB, 2)}°` : PH;
  const lit = state.frames.filter(f => f.is_sunlit);
  $('#sumEnergy').innerHTML = lit.length ? `${fmt(mean(lit, 'energy') * 100, 2)} %` : PH;
  $('#sumCount').textContent = state.frames.length;
  $('#errPill').textContent = maeM !== undefined
    ? `${fmt(maeM, 2)}° contre ${fmt(maeB, 2)}°`
    : 'optimum non fourni';

  /* --- journal : uniquement les changements notables --- */
  const prev = state.lastLogged;
  if (v.rejected && (!prev || !prev.rejected)) {
    pushLog('warn', 'Entrées refusées', v.rejected, v.t);
    state.lastLogged = v;
  } else if (prev && prev.is_sunlit !== v.is_sunlit) {
    pushLog(v.is_sunlit ? 'move' : 'hold',
      v.is_sunlit ? 'Sortie d’ombre' : 'Entrée dans l’ombre',
      v.is_sunlit
        ? `Reprise de la visée : angle porté à ${fmt(v.predicted, 1)}°.`
        : 'Plus de rayonnement direct : repli à 0°.',
      v.t, prev ? Math.abs(v.predicted - prev.predicted) : 0);
    state.lastLogged = v;
  } else if (prev && Math.abs(prev.predicted - v.predicted) > 2) {
    const deg = Math.abs(v.predicted - prev.predicted);
    pushLog('move', `Angle porté à ${fmt(v.predicted, 1)}°`,
      `Déplacement de ${fmt(deg, 1)}° depuis la dernière consigne · formule simple : ${fmt(v.simple, 1)}°.`,
      v.t, deg);
    state.lastLogged = v;
  } else if (!prev) {
    pushLog('info', 'Première trame reçue',
      `Élévation ${fmt(v.sun_elevation, 1)}°, angle prédit ${fmt(v.predicted, 1)}° via ${v.predSource}.`, v.t);
    state.lastLogged = v;
  }

  /* --- graphiques --- */
  renderLegends($('#angleLegend'), $('#errorLegend'), v);
  const now = performance.now();
  if (now - lastChartUpdate > 220) {
    lastChartUpdate = now;
    updateCharts(state.charts, state.frames);
    renderTable($('#dataTable tbody'), state.frames);
  }

  /* --- sparkline --- */
  state.spark.push(v.predicted);
  if (state.spark.length > 90) state.spark.shift();
  drawSpark($('#sparkAngle'), state.spark);

  /* --- 3D --- */

  /* --- cadence --- */
  const w = state.rateWindow;
  if (w.length > 2) {
    const rate = (w.length - 1) / ((w.at(-1) - w[0]) / 1000);
    $('#sideRate').textContent = `${rate.toFixed(1)} /s`;
  }
  $('#sideBar').style.width = `${(v.confidence * 100).toFixed(0)}%`;
}

/* =========================== SOURCE =========================== */

function onSourceStatus(s) {
  $('#sideSource').textContent = s.label;
  $('#sourceName').textContent = s.mode === 'idle' ? 'aucune source connectée' : s.label;
  $('#sourceMode').textContent = { idle: 'en attente', push: 'injection', api: 'API', replay: 'rejeu' }[s.mode];
  $('#aboutSource').textContent = s.label;
  $('#linkPulse').style.animationPlayState = s.running ? 'running' : 'paused';

  if (!s.detected) return;

  // le flux demarre seul : il n'y a pas de commande de lecture sur cette page
  if (s.mode === 'replay' && !s.running) state.source.start();
  $('#emptyBanner').hidden = s.mode !== 'idle';
}

/* ====================== TELEMETRIE (debogage) ====================== */

function telemetry() {
  const v = state.last;
  if (!v) return { etat: 'aucune trame reçue' };
  const m = state.metrics;
  const withTruth = state.frames.filter(f => f.errModel !== undefined);
  const mean = (a, k) => a.length ? a.reduce((s, f) => s + f[k], 0) / a.length : null;
  return {
    horodatage: clockLabel(v.t).time,
    source: state.source?.state().label,
    entrees_modele: {
      sun_elevation_deg: +v.sun_elevation.toFixed(2),
      sun_azimuth_deg: +v.sun_azimuth.toFixed(1),
      is_sunlit: v.is_sunlit,
      dust_level_pct: +v.dust_level.toFixed(1),
      surface_temp_C: +v.surface_temp.toFixed(1)
    },
    sortie: {
      angle_predit_deg: +v.predicted.toFixed(2),
      incertitude_deg: v.uncertainty !== undefined ? +v.uncertainty.toFixed(2) : null,
      predicteur: v.predSource,
      confiance_pct: +(v.confidence * 100).toFixed(0),
      entrees_refusees: v.rejected || null
    },
    comparaison: {
      formule_simple_deg: +v.simple.toFixed(2),
      correction_apprise_deg: +v.delta.toFixed(2),
      optimum_physique_deg: v.optimal !== undefined ? +v.optimal.toFixed(2) : null,
      erreur_modele_deg: v.errModel !== undefined ? +v.errModel.toFixed(2) : null,
      erreur_formule_deg: v.errSimple !== undefined ? +v.errSimple.toFixed(2) : null
    },
    energie_recuperee_pct: +(v.energy * 100).toFixed(2),
    fenetre_glissante: {
      trames: state.frames.length,
      erreur_moyenne_modele_deg: mean(withTruth, 'errModel'),
      erreur_moyenne_formule_deg: mean(withTruth, 'errSimple')
    },
    validation_modele: m
  };
}

/* ========================== SCENE 3D EMBARQUEE ========================== */

/**
 * La carte affiche la scene 3D de l'equipe (frontend/digital_twin), telle
 * quelle, dans un cadre. On masque seulement ses panneaux d'interface pour ne
 * garder que le rendu : la page complete, avec tous ses reglages, est a un
 * clic sur la carte.
 *
 * Cette scene tourne sur SA PROPRE simulation. Le bandeau de valeurs sous le
 * cadre reste la telemetrie du tableau de bord — les deux sont independants,
 * et l'etiquette « scene autonome » le dit.
 */
const SCENE_UI = ['#dock', '#topstrip', '#hint', '#popup', '#heat-legend',
  '#sensor-list', '#p-sensors', '#scenario-banner', '#gate-log', '#gate-queue',
  '#src-live', '#src-replay'];

function mountScene() {
  const frame = $('#twinFrame');
  if (!frame) return;

  const failed = setTimeout(() => {
    $('#twinFallback')?.replaceChildren();
    $('#twinFallback')?.insertAdjacentHTML('afterbegin',
      '<svg class="ic" viewBox="0 0 24 24"><use href="#i-alert"/></svg>' +
      '<p>Scène 3D indisponible (WebGL ou CDN bloqué).<br>Les instruments 2D restent opérationnels.</p>');
  }, 12000);

  frame.addEventListener('load', () => {
    clearTimeout(failed);
    $('#twinFallback')?.remove();
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      const style = doc.createElement('style');
      style.textContent = SCENE_UI.join(',') + '{display:none!important}' +
        'html,body{overflow:hidden!important;background:#0b1020}';
      doc.head.appendChild(style);
    } catch {
      // page servie depuis une autre origine : on la laisse telle quelle
    }
  }, { once: true });
}

/* ============================== BOOT ============================== */

function applyTheme() {
  // Thème clair par défaut. `?theme=dark` reste disponible pour une projection
  // en salle sombre ou une capture, mais rien ne bascule tout seul.
  const url = new URLSearchParams(location.search).get('theme');
  document.documentElement.dataset.theme = url === 'dark' ? 'dark' : 'light';
}

function wireNav() {
  $$('[data-nav]').forEach(a => a.onclick = e => {
    e.preventDefault();
    document.getElementById(a.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      $$('[data-nav]').forEach(a => a.classList.toggle('is-active', a.getAttribute('href') === `#${en.target.id}`));
    }
  }, { root: $('#scroll'), threshold: .28, rootMargin: '-10% 0px -55% 0px' });
  ['sec-kpi', 'sec-twin', 'sec-analytics', 'sec-error', 'sec-forecast', 'sec-perf', 'sec-table', 'sec-about', 'sec-control', 'sec-inputs']
    .forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
}

async function boot() {
  applyTheme();
  buildDomeTicks();
  buildFeatureList();
  wireNav();

  resetLog();                       // chaque chargement ouvre une session propre
  renderLastEvents([]);
  $('#navLogs').textContent = '0';

  state.charts = createCharts($('#angleChart'), $('#errorChart'));
  state.metrics = await loadMetrics(DEFAULT_METRICS);
  renderMetrics();

  loadForecast().then(fc => renderForecast(fc, {
    heat: $('#fcHeat'), legend: $('#fcLegend'), days: $('#fcDays'), source: $('#fcSource')
  }));

  state.predictor = createPredictor({
    onStatus: s => { $('#aboutModel').textContent = s.source; }
  });

  state.source = createDataSource({ onFrame, onStatus: onSourceStatus });

  mountScene();

  renderTable($('#dataTable tbody'), []);
}

boot();

/* point d'entree pour l'integration et le debogage */
window.SolarNav = Object.assign(window.SolarNav || {}, {
  state, telemetry,
  frames: () => state.frames,
  metrics: () => state.metrics,
  logs: () => readLog(),
  LOG_MAX
});
