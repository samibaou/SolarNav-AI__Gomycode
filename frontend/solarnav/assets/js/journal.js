/* =========================================================================
   journal.js — page Journal

   Le tableau de bord ecrit ses evenements dans le stockage local ; cette page
   les relit et se rafraichit toute seule. Les deux onglets peuvent donc rester
   ouverts cote a cote pendant une demonstration.
   ========================================================================= */

import { LOG_KEY, LOG_MAX, readLog } from './log.js';

const $ = s => document.querySelector(s);

const ICONS = { move: '#i-target', hold: '#i-pause', warn: '#i-alert', info: '#i-shield' };
const KIND_LABEL = { move: 'mouvement', hold: 'exposition', warn: 'anomalie', info: 'information' };

function stamp(t) {
  const d = new Date(t);
  if (isNaN(d.getTime())) return { time: '—', date: '' };
  const p = n => String(n).padStart(2, '0');
  return {
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
    date: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`
  };
}

let lastSignature = '';

function render() {
  const items = readLog();
  const signature = `${items.length}|${items.at(-1)?.t || 0}`;
  if (signature === lastSignature) return;          // rien de neuf, on ne repeint pas
  lastSignature = signature;

  /* --- compteurs --- */
  const count = k => items.filter(i => i.kind === k).length;
  $('#cMove').textContent = count('move');
  $('#cHold').textContent = count('hold');
  $('#cWarn').textContent = count('warn');
  const degrees = items.reduce((s, i) => s + (Number(i.deg) || 0), 0);
  $('#cDeg').firstChild.textContent = Math.round(degrees);

  $('#navLogs').textContent = items.length;
  $('#sideCount').textContent = items.length;
  $('#sideBar').style.width = `${Math.min(100, items.length / LOG_MAX * 100).toFixed(0)}%`;

  /* --- en-tete --- */
  if (items.length) {
    const a = stamp(items[0].t), b = stamp(items.at(-1).t);
    $('#logRange').textContent = `${items.length} évènement${items.length > 1 ? 's' : ''} · de ${a.time} à ${b.time}`;
    $('#clockTime').textContent = b.time;
  } else {
    $('#logRange').textContent = 'aucun évènement';
    $('#clockTime').textContent = '--:--';
  }

  /* --- liste --- */
  const el = $('#log');
  if (!items.length) {
    el.innerHTML = `<li class="log-empty">Aucun évènement enregistré.<br>
      Ouvrez le <a href="index.html">tableau de bord</a> avec une source de télémétrie connectée.</li>`;
    return;
  }

  el.innerHTML = items.slice().reverse().map(d => {
    const s = stamp(d.t);
    return `<li class="log-it" data-kind="${d.kind}">
      <span class="log-ic"><svg class="ic" viewBox="0 0 24 24"><use href="${ICONS[d.kind] || '#i-shield'}"/></svg></span>
      <span class="log-txt">
        <b>${d.title}</b>
        <span>${d.reason}</span>
        <i class="log-kind">${KIND_LABEL[d.kind] || d.kind}</i>
      </span>
      <span class="log-t">${s.time}<em>${s.date}</em></span>
    </li>`;
  }).join('');
}

render();

/* le tableau de bord ecrit dans un autre onglet : on suit les deux voies */
addEventListener('storage', e => { if (e.key === LOG_KEY) render(); });
setInterval(render, 1500);
