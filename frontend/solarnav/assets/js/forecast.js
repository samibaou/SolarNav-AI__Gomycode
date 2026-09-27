/* =========================================================================
   forecast.js — prevision a 7 jours

   Comme la telemetrie, la prevision vient de la base du projet : ce module
   ne la calcule pas, il la lit et la met en forme.

   ------------------------------------------------------------- CONTRAT
   {
     "generated_at": 1738072800000,          // ms epoch, optionnel
     "source": "modele ExtraTrees + ephemerides",   // libelle, optionnel
     "days": [
       {
         "date":        "2026-02-01",        // ISO, REQUIS
         "energy_pct":   98.7,               // energie recuperable attendue, %
         "peak_angle":   47.2,               // angle de pointe predit, deg
         "min_angle":    12.0,               // deg, optionnel
         "sunlit_pct":   62,                 // fraction au soleil, %
         "dust_level":   14.2,               // %, optionnel
         "temp_max":     96,                 // degres C, optionnel
         "confidence":   0.91,               // 0..1, optionnel
         "hours": [                          // 24 entrees, optionnel
           { "h": 0, "energy": 0.0, "angle": 0 }, ...
         ]
       }
     ]
   }

   Sans `hours`, la carte affiche seulement la bande des sept jours.
   ========================================================================= */

import { clamp, fmt } from './model.js';

const API = 'api/forecast';
const FILE = 'data/forecast.json';

/** Rampe sequentielle a teinte unique : clair = peu d'energie, sombre = beaucoup. */
const RAMP = ['#fdf3e0', '#fbe2b4', '#f8cb80', '#f3ae4b', '#e8901f', '#cc7310', '#a85a08'];

const JOURS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/* ----------------------------------------------------------- CHARGEMENT */

export async function loadForecast() {
  for (const [url, label] of [[API, 'API /api/forecast'], [FILE, 'data/forecast.json']]) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      const days = Array.isArray(j) ? j : (j.days || []);
      if (!days.length) continue;
      return { days: days.map(normalizeDay).filter(Boolean), source: j.source || label, generated_at: j.generated_at };
    } catch { /* on essaie la source suivante */ }
  }
  return null;
}

function normalizeDay(d) {
  if (!d || typeof d !== 'object') return null;
  const num = (v, def) => (isFinite(Number(v)) ? Number(v) : def);
  const hours = Array.isArray(d.hours)
    ? d.hours.map(h => ({
      h: num(h.h ?? h.hour, 0),
      energy: clamp(num(h.energy ?? h.energy_pct / 100, 0), 0, 1),
      angle: num(h.angle ?? h.tilt, undefined)
    }))
    : null;

  return {
    date: d.date || d.day || '',
    energy_pct: num(d.energy_pct ?? d.energy, undefined),
    peak_angle: num(d.peak_angle ?? d.angle_max, undefined),
    min_angle: num(d.min_angle ?? d.angle_min, undefined),
    sunlit_pct: num(d.sunlit_pct, undefined),
    dust_level: num(d.dust_level ?? d.dust, undefined),
    temp_max: num(d.temp_max, undefined),
    confidence: num(d.confidence, undefined),
    hours
  };
}

/* ------------------------------------------------------------- RENDU */

const todayISO = () => new Date().toISOString().slice(0, 10);

const label = iso => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { day: iso || '—', date: '', today: false };
  return {
    day: JOURS[d.getUTCDay()],
    date: `${d.getUTCDate()} ${MOIS[d.getUTCMonth()]}`,
    today: String(iso).slice(0, 10) === todayISO()
  };
};

const shade = e => RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.round(e * (RAMP.length - 1))))];

export function renderForecast(fc, els) {
  if (!fc) {
    els.heat.innerHTML = '';
    els.legend.innerHTML = '';
    els.days.innerHTML = `<div class="empty-hint">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-plug"/></svg>
      <span>Aucune prévision disponible. Exposez <code>GET /api/forecast</code> ou déposez
      <code>data/forecast.json</code> — le contrat est décrit dans le README.</span></div>`;
    els.source.textContent = 'non fournie';
    return;
  }

  els.source.textContent = fc.source;

  /* ---- bande des sept jours ---- */
  els.days.innerHTML = fc.days.map(d => {
    const l = label(d.date);
    const e = d.energy_pct;
    return `<div class="fcd ${l.today ? 'is-now' : ''}">
      <span class="fcd-d">${l.today ? 'auj.' : l.day}</span>
      <span class="fcd-date">${l.date}</span>
      <span class="fcd-e" style="color:${e === undefined ? 'var(--ink-3)' : shade(e / 100)}">
        ${e === undefined ? '<span class="ph">—</span>' : fmt(e, 1)}<i>%</i></span>
      <span class="fcd-bar"><i style="width:${clamp(e ?? 0, 0, 100)}%;background:${shade((e ?? 0) / 100)}"></i></span>
      <span class="fcd-rows">
        <em>pointe</em><b>${d.peak_angle === undefined ? '—' : fmt(d.peak_angle, 0) + '°'}</b>
        <em>au soleil</em><b>${d.sunlit_pct === undefined ? '—' : fmt(d.sunlit_pct, 0) + ' %'}</b>
        <em>poussière</em><b>${d.dust_level === undefined ? '—' : fmt(d.dust_level, 0) + ' %'}</b>
      </span>
      ${d.confidence === undefined ? '' :
        `<span class="fcd-conf" title="confiance de la prévision">${fmt(d.confidence * 100, 0)} % sûr</span>`}
    </div>`;
  }).join('');

  /* ---- grille heure par heure ---- */
  const withHours = fc.days.filter(d => d.hours && d.hours.length);
  if (!withHours.length) {
    els.heat.innerHTML = `<p class="fc-note">La source ne fournit pas le détail horaire
      (<code>hours</code>) : seule la synthèse par jour est affichée.</p>`;
    els.legend.innerHTML = '';
    return;
  }

  const hourTicks = [0, 3, 6, 9, 12, 15, 18, 21];
  els.heat.innerHTML = `
    <div class="heat-head"><span></span><span class="heat-ticks">${hourTicks.map(h => `<span>${String(h).padStart(2, '0')}h</span>`).join('')}</span></div>
    ${fc.days.map(d => {
      const l = label(d.date);
      const cells = Array.from({ length: 24 }, (_, h) => {
        const cell = d.hours?.find(x => x.h === h);
        if (!cell) return `<i class="heat-cell is-void" title="${l.date} ${h}h — pas de donnée"></i>`;
        const dark = cell.energy <= 0.005;
        const t = `${l.date} ${String(h).padStart(2, '0')}h — ${(cell.energy * 100).toFixed(0)} % d’énergie` +
          (cell.angle !== undefined ? `, angle ${cell.angle.toFixed(0)}°` : '');
        return `<i class="heat-cell${dark ? ' is-dark' : ''}"${dark ? '' : ` style="background:${shade(cell.energy)}"`} title="${t}"></i>`;
      }).join('');
      return `<div class="heat-row"><span class="heat-lbl">${l.today ? 'auj.' : l.day}</span><span class="heat-cells">${cells}</span></div>`;
    }).join('')}`;

  els.legend.innerHTML =
    `<span class="fc-leg-lbl">Énergie récupérable</span>
     <span class="fc-leg-ramp">${RAMP.map(c => `<i style="background:${c}"></i>`).join('')}</span>
     <span class="fc-leg-ends"><em>0 %</em><em>100 %</em></span>
     <span class="fc-leg-void"><i></i>hors exposition</span>`;
}
