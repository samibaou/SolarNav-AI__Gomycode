/* =========================================================================
   charts.js — graphiques (Chart.js 4)
   Palette validee CVD sur les deux surfaces :
     modele #1baf7a/#199e70 · formule #eb6834/#d95926 · optimum #2a78d6/#3987e5
   Traits fins, grille sobre en trait plein, pas de point sur chaque valeur,
   legende permanente + etiquettes en bout de courbe.
   ========================================================================= */

const SERIES = {
  light: { predicted: '#1baf7a', simple: '#eb6834', optimal: '#2a78d6' },
  dark: { predicted: '#199e70', simple: '#d95926', optimal: '#3987e5' }
};

export const seriesColors = () =>
  SERIES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];

const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function tokens() {
  return {
    ink2: cssVar('--ink-2') || '#545e78',
    ink3: cssVar('--ink-3') || '#8a93ab',
    line: cssVar('--line') || '#e1e6f2',
    surface: cssVar('--surface') || '#fff'
  };
}

/* ------------------------------------------------------------- PLUGINS */

/** Etiquette directe en bout de courbe : pastille coloree + texte en encre. */
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea } = chart;
    const t = tokens();
    const items = [];

    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || ds.hidden || !meta.data.length) return;
      const last = meta.data[meta.data.length - 1];
      if (!last || last.x < chartArea.left) return;
      items.push({ y: last.y, x: last.x, color: ds.borderColor, text: ds.label });
    });

    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) {
      if (items[i].y - items[i - 1].y < 15) items[i].y = items[i - 1].y + 15;
    }

    ctx.save();
    ctx.font = '600 11px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const it of items) {
      const w = ctx.measureText(it.text).width;
      const x = Math.min(it.x + 9, chartArea.right - w - 14);
      const y = Math.max(chartArea.top + 8, Math.min(it.y, chartArea.bottom - 8));
      ctx.fillStyle = t.surface; ctx.globalAlpha = .82;
      ctx.beginPath(); ctx.roundRect(x - 3, y - 8, w + 16, 16, 5); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = it.color;
      ctx.beginPath(); ctx.roundRect(x, y - 3.5, 7, 7, 2); ctx.fill();
      ctx.fillStyle = t.ink2;
      ctx.fillText(it.text, x + 12, y + .5);
    }
    ctx.restore();
  }
};

/** Reticule vertical au survol. */
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const act = chart.tooltip?.getActiveElements?.() || [];
    if (!act.length) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = tokens().line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(act[0].element.x, chartArea.top);
    ctx.lineTo(act[0].element.x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  }
};

/** Bandes verticales la ou le panneau est hors exposition. */
const eclipseBands = {
  id: 'eclipseBands',
  beforeDatasetsDraw(chart) {
    const lit = chart.$sunlit;
    if (!lit || !lit.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    ctx.fillStyle = tokens().line;
    ctx.globalAlpha = .6;
    let start = null;
    for (let i = 0; i <= lit.length; i++) {
      const dark = i < lit.length && !lit[i];
      if (dark && start === null) start = i;
      if (!dark && start !== null) {
        const x1 = scales.x.getPixelForValue(start);
        const x2 = scales.x.getPixelForValue(i - 1);
        ctx.fillRect(x1, chartArea.top, Math.max(2, x2 - x1), chartArea.bottom - chartArea.top);
        start = null;
      }
    }
    ctx.restore();
  }
};

/* ========================================================== GRAPHIQUES */

function baseOptions(t, title) {
  return {
    responsive: true, maintainAspectRatio: false,
    layout: { padding: { right: 92, top: 6 } },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#121734', padding: 11, cornerRadius: 10,
        boxWidth: 8, boxHeight: 8, boxPadding: 4, borderWidth: 0,
        titleFont: { size: 11, weight: '700' }, bodyFont: { size: 11.5 },
        callbacks: { label: c => ` ${c.dataset.label} : ${c.parsed.y.toFixed(2)} °` }
      }
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: t.ink3, maxTicksLimit: 9, padding: 6, autoSkip: true } },
      y: {
        grid: { color: t.line, drawTicks: false, lineWidth: 1 },
        border: { display: false },
        ticks: { color: t.ink3, padding: 8, maxTicksLimit: 6, callback: v => `${v}°` },
        title: { display: true, text: title, color: t.ink3, font: { size: 10, weight: '600' } },
        beginAtZero: true
      }
    }
  };
}

function lineSet(keys, labels, c, t) {
  return keys.map(k => ({
    key: k, label: labels[k], data: [],
    borderColor: c[k], backgroundColor: 'transparent',
    borderWidth: k === 'predicted' ? 2.4 : 1.8,
    borderDash: k === 'optimal' ? [4, 3] : undefined,
    pointRadius: 0, pointHoverRadius: 5,
    pointHoverBackgroundColor: c[k], pointHoverBorderColor: t.surface, pointHoverBorderWidth: 2,
    tension: .25, fill: false, clip: 6
  }));
}

export function createCharts(angleCanvas, errorCanvas) {
  if (typeof Chart === 'undefined') { console.warn('[charts] Chart.js absent'); return null; }

  Chart.defaults.font.family = '"Plus Jakarta Sans", system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.animation.duration = 240;

  const t = tokens(), c = seriesColors();

  const angle = new Chart(angleCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: lineSet(['optimal', 'simple', 'predicted'],
        { optimal: 'Optimum', simple: 'Formule simple', predicted: 'Modèle' }, c, t)
    },
    options: baseOptions(t, 'Angle (°)'),
    plugins: [endLabels, crosshair, eclipseBands]
  });

  const error = new Chart(errorCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: lineSet(['simple', 'predicted'],
        { simple: 'Erreur formule', predicted: 'Erreur modèle' }, c, t)
    },
    options: baseOptions(t, 'Erreur absolue (°)'),
    plugins: [endLabels, crosshair, eclipseBands]
  });

  return { angle, error };
}

/* ------------------------------------------------------ MISES A JOUR */

const hhmm = t => {
  const d = new Date(t);
  return isNaN(d.getTime()) ? String(t)
    : `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

export function updateCharts(charts, frames) {
  if (!charts) return;
  const c = seriesColors();
  const labels = frames.map(f => hhmm(f.t));
  const sunlit = frames.map(f => f.is_sunlit);

  for (const [name, ch] of Object.entries(charts)) {
    ch.data.labels = labels;
    ch.$sunlit = sunlit;
    ch.data.datasets.forEach(ds => {
      ds.borderColor = c[ds.key];
      ds.pointHoverBackgroundColor = c[ds.key];
      ds.data = frames.map(f => name === 'angle'
        ? (ds.key === 'predicted' ? f.predicted : ds.key === 'simple' ? f.simple : f.optimal)
        : (ds.key === 'predicted' ? f.errModel : f.errSimple));
    });
    ch.update('none');
  }
}

export function refreshTheme(charts) {
  if (!charts) return;
  const t = tokens();
  for (const ch of Object.values(charts)) {
    ch.options.scales.x.ticks.color = t.ink3;
    ch.options.scales.y.ticks.color = t.ink3;
    ch.options.scales.y.grid.color = t.line;
    ch.options.scales.y.title.color = t.ink3;
    ch.update('none');
  }
}

/* -------------------------------------------------------- LEGENDES */

const val = (x, unit = '°') => (x === undefined || !isFinite(x) ? '—' : `${x.toFixed(2)} ${unit}`);

export function renderLegends(angleEl, errorEl, v) {
  const c = seriesColors();
  const row = (k, label, x) =>
    `<span class="lg"><i style="background:${c[k]}"></i>${label} <b>${val(x)}</b></span>`;

  angleEl.innerHTML =
    row('predicted', 'Modèle', v.predicted) +
    row('simple', 'Formule simple', v.simple) +
    row('optimal', 'Optimum', v.optimal);

  errorEl.innerHTML =
    row('predicted', 'Erreur modèle', v.errModel) +
    row('simple', 'Erreur formule', v.errSimple);
}

/* --------------------------------------------------------- TABLEAU */

export function renderTable(tbody, frames, maxRows = 12) {
  const rows = frames.slice(-maxRows).reverse().map(f => {
    const d = f.predicted - f.simple;
    return `<tr>
      <td>${hhmm(f.t)}</td>
      <td>${f.sun_elevation.toFixed(1)}°</td>
      <td>${f.simple.toFixed(1)}°</td>
      <td>${f.predicted.toFixed(1)}°</td>
      <td>${f.optimal === undefined ? '—' : f.optimal.toFixed(1) + '°'}</td>
      <td class="${Math.abs(d) < 1 ? '' : 'pos'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}°</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('') || '<tr><td colspan="6">En attente de télémétrie</td></tr>';
}

/* ------------------------------------------------------- SPARKLINE */

export function drawSpark(canvas, values, color = 'rgba(255,255,255,.85)') {
  const dpr = Math.min(devicePixelRatio, 2);
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 58;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (values.length < 2) return;

  const max = Math.max(...values, 1), n = values.length;
  const x = i => (i / (n - 1)) * w;
  const y = v => h - 6 - (v / max) * (h - 12);

  g.beginPath(); g.moveTo(0, h);
  values.forEach((v, i) => g.lineTo(x(i), y(v)));
  g.lineTo(w, h); g.closePath();
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, 'rgba(255,255,255,.26)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fill();

  g.beginPath();
  values.forEach((v, i) => i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)));
  g.strokeStyle = color; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();

  g.beginPath(); g.arc(x(n - 1), y(values[n - 1]), 3, 0, 7); g.fillStyle = '#fff'; g.fill();
}
