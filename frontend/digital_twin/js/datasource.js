// SolarNav — sources de données environnementales.
// Toutes les entrées (soleil, irradiance, température, vent, poussière) passent par une source qui renvoie
// un EnvironmentFrame. index.html copie ce frame dans `sim` ; le reste du code ne lit que `sim`.
//
// EnvironmentFrame = {
//   status: 'ok' | 'no-data',
//   sunElevDeg, sunAzimuthDeg,     // azimut boussole : 0 = N, 90 = E, 180 = S
//   sunPos: {x,y,z} | null,        // position de scène imposée (simulation historique) ; sinon dérivée des angles
//   sunSin,                        // facteur d'atténuation atmosphérique (= sin(élévation) hors simulation)
//   ghi, ghiClear|null,            // irradiance globale horizontale (W/m²)
//   dni, dhi, albedo,              // direct normal, diffus horizontal (W/m²), réflectance du sol → irradiance dans le plan des panneaux
//   ambientC, windMs,
//   dustPct|null,                  // salissure mesurée ; null = intégrée par le modèle
//   cloudFactor|null,              // 0..1, sert aussi au rendu des nuages
//   datetime|null,                 // 'YYYY-MM-DDTHH:MM' en heure solaire locale (LST)
//   solarHour?,                    // live : heure solaire réelle du site (impose l'heure de la page)
//   live?: { body, site, generatedAt, sources: [meta soleil, meta météo], spaceWeather }   // live uniquement
// }
// Une source expose : { id, label, read({timeOfDay, day}) → EnvironmentFrame | null, days }.

const SITE_DEFAULT = { name: 'Ouarzazate — Noor', lat: 30.99, lon: -6.86 };
const REPLAY_ALBEDO = 0.25;   // sol désertique clair

// Position du soleil à partir du jour de l'année et de l'heure solaire locale (précision ~1°, suffisante ici).
function solarPosition(dayOfYear, solarHour, latDeg) {
  const r = Math.PI / 180;
  const decl = 23.45 * Math.sin(r * 360 / 365 * (284 + dayOfYear));
  const H = 15 * (solarHour - 12), lat = latDeg * r, d = decl * r;
  const sinEl = Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(H * r);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const cosAz = (Math.sin(d) - Math.sin(el) * Math.sin(lat)) / (Math.cos(el) * Math.cos(lat) || 1e-9);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / r;
  if (H > 0) az = 360 - az;                       // après-midi : soleil à l'ouest
  return { elevDeg: el / r, azimuthDeg: az };
}

// Convention de scène : +X = Est, +Y = haut, +Z = Sud.
function sunVectorFromAngles(elevDeg, azimuthDeg, dist = 1) {
  const r = Math.PI / 180, ce = Math.cos(elevDeg * r);
  return { x: dist * ce * Math.sin(azimuthDeg * r), y: dist * Math.sin(elevDeg * r), z: -dist * ce * Math.cos(azimuthDeg * r) };
}
function anglesFromSunVector(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  const elevDeg = Math.asin(Math.max(-1, Math.min(1, v.y / len))) * 180 / Math.PI;
  const azimuthDeg = ((Math.atan2(v.x, -v.z) * 180 / Math.PI) % 360 + 360) % 360;
  return { elevDeg, azimuthDeg };
}

// Décomposition de la GHI en direct normal (DNI) et diffus horizontal (DHI) — modèle d'Erbs (1982).
// Indispensable avec des données réelles : à soleil bas, la GHI est surtout diffuse.
function decomposeGHI(ghi, sunElevDeg, doy) {
  const sinEl = Math.sin(sunElevDeg * Math.PI / 180);
  if (ghi <= 0) return { dni: 0, dhi: 0 };
  if (sinEl <= 0.02) return { dni: 0, dhi: ghi };
  const i0 = 1367 * (1 + 0.033 * Math.cos(2 * Math.PI * doy / 365));
  const kt = Math.min(1, ghi / (i0 * sinEl));
  const kd = kt <= 0.22 ? 1 - 0.09 * kt
    : kt <= 0.8 ? 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4
    : 0.165;
  // DNI bornée par un ciel clair (Meinel, masse d'air 1/sin) : évite les surestimations près du lever/coucher,
  // où les moyennes horaires interpolées gonflent kt. Le reste est compté en diffus pour conserver la GHI mesurée.
  const dniClear = i0 * Math.pow(0.7, Math.pow(1 / sinEl, 0.678));
  const dni = Math.min(dniClear, (ghi - kd * ghi) / sinEl);
  return { dni, dhi: ghi - dni * sinEl };
}

function dayOfYear(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
}

// ---------- Parsing des fichiers de replay ----------
// Formats acceptés (heure solaire locale, pas horaire) :
//  1. NASA POWER JSON (API hourly, time-standard=LST) : ALLSKY_SFC_SW_DWN, T2M, WS10M|WS2M, [CLRSKY_SFC_SW_DWN]
//  2. NASA POWER CSV (bloc -BEGIN HEADER- … -END HEADER-, colonnes YEAR,MO,DY,HR,…)
//  3. JSON SolarNav : { site:{name,lat,lon}, records:[{date:'YYYY-MM-DD', hour, ghi, tempC, windMs, ghiClear?, dustPct?}] }
//  4. CSV SolarNav : en-tête date,hour,ghi,tempC,windMs[,ghiClear][,dustPct] ; lignes '# lat=…', '# lon=…', '# name=…' optionnelles
// Résultat : { site, startDate, days, records:[{t, date, hour, ghi, ghiClear, tempC, windMs, dustPct}] } avec t = heures depuis startDate 00:00.
const FILL = -999;
const num = v => (v === '' || v === null || v === undefined || Number(v) <= FILL + 1e-6 || Number.isNaN(Number(v))) ? null : Number(v);

function finalizeReplay(site, rows) {
  rows = rows.filter(r => r.date && Number.isFinite(r.hour)).sort((a, b) => (a.date + String(a.hour).padStart(2, '0')).localeCompare(b.date + String(b.hour).padStart(2, '0')));
  if (!rows.length) throw new Error('aucun enregistrement exploitable');
  const startDate = rows[0].date, t0 = Date.UTC(...startDate.split('-').map((x, i) => i === 1 ? x - 1 : +x));
  const records = rows.map(r => {
    const [y, m, d] = r.date.split('-').map(Number);
    return { ...r, t: (Date.UTC(y, m - 1, d) - t0) / 3600000 + r.hour };
  });
  for (const k of ['ghi', 'tempC', 'windMs']) if (!records.some(r => r[k] !== null)) throw new Error('colonne manquante ou vide : ' + k);
  return { site, startDate, days: Math.ceil((records[records.length - 1].t + 1) / 24), records };
}

function parsePowerJSON(o) {
  const p = o.properties.parameter, [lon, lat] = o.geometry?.coordinates || [SITE_DEFAULT.lon, SITE_DEFAULT.lat];
  const ghi = p.ALLSKY_SFC_SW_DWN, t2m = p.T2M, ws = p.WS10M || p.WS2M, clr = p.CLRSKY_SFC_SW_DWN || {};
  if (!ghi || !t2m || !ws) throw new Error('NASA POWER : paramètres requis ALLSKY_SFC_SW_DWN, T2M, WS10M (ou WS2M)');
  if (o.header?.time_standard && o.header.time_standard !== 'LST') throw new Error('NASA POWER : utiliser time-standard=LST');
  const rows = Object.keys(ghi).map(k => ({
    date: `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`, hour: +k.slice(8, 10),
    ghi: num(ghi[k]), ghiClear: num(clr[k]), tempC: num(t2m[k]), windMs: num(ws[k]), dustPct: null,
  }));
  return finalizeReplay({ name: 'NASA POWER', lat, lon }, rows);
}

function splitCSV(text) { return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean); }

function parsePowerCSV(text) {
  const [head, body] = text.split(/-END HEADER-/);
  const lat = +(head.match(/Latitude\s+(-?[\d.]+)/i)?.[1] ?? SITE_DEFAULT.lat), lon = +(head.match(/Longitude\s+(-?[\d.]+)/i)?.[1] ?? SITE_DEFAULT.lon);
  const lines = splitCSV(body), cols = lines[0].split(',').map(s => s.trim().toUpperCase()), ix = c => cols.indexOf(c);
  if (ix('ALLSKY_SFC_SW_DWN') < 0 || ix('T2M') < 0 || (ix('WS10M') < 0 && ix('WS2M') < 0)) throw new Error('NASA POWER CSV : colonnes ALLSKY_SFC_SW_DWN, T2M, WS10M requises');
  const w = ix('WS10M') >= 0 ? ix('WS10M') : ix('WS2M');
  const rows = lines.slice(1).map(l => {
    const f = l.split(',');
    return { date: `${f[ix('YEAR')]}-${String(f[ix('MO')]).padStart(2, '0')}-${String(f[ix('DY')]).padStart(2, '0')}`, hour: +f[ix('HR')],
      ghi: num(f[ix('ALLSKY_SFC_SW_DWN')]), ghiClear: ix('CLRSKY_SFC_SW_DWN') >= 0 ? num(f[ix('CLRSKY_SFC_SW_DWN')]) : null,
      tempC: num(f[ix('T2M')]), windMs: num(f[w]), dustPct: null };
  });
  return finalizeReplay({ name: 'NASA POWER', lat, lon }, rows);
}

function parseSolarNavCSV(text) {
  const site = { ...SITE_DEFAULT };
  const lines = splitCSV(text).filter(l => {
    const m = l.match(/^#\s*(lat|lon|name)\s*=\s*(.+)$/i);
    if (m) site[m[1].toLowerCase()] = m[1].toLowerCase() === 'name' ? m[2].trim() : +m[2];
    return !l.startsWith('#');
  });
  const cols = lines[0].split(',').map(s => s.trim()), ix = c => cols.indexOf(c);
  if (ix('date') < 0 || ix('hour') < 0) throw new Error('CSV : colonnes date,hour,ghi,tempC,windMs requises');
  const rows = lines.slice(1).map(l => {
    const f = l.split(',').map(s => s.trim()), g = c => ix(c) >= 0 ? num(f[ix(c)]) : null;
    return { date: f[ix('date')], hour: +f[ix('hour')], ghi: g('ghi'), ghiClear: g('ghiClear'), tempC: g('tempC'), windMs: g('windMs'), dustPct: g('dustPct') };
  });
  return finalizeReplay(site, rows);
}

function parseReplay(input) {
  if (typeof input === 'object' && input !== null) {
    if (input.properties?.parameter) return parsePowerJSON(input);
    if (Array.isArray(input.records)) {
      const rows = input.records.map(r => ({ date: r.date, hour: +r.hour, ghi: num(r.ghi), ghiClear: num(r.ghiClear), tempC: num(r.tempC), windMs: num(r.windMs), dustPct: num(r.dustPct) }));
      return finalizeReplay({ ...SITE_DEFAULT, ...(input.site || {}) }, rows);
    }
    throw new Error('JSON non reconnu (attendu : NASA POWER ou {site, records})');
  }
  const text = String(input).replace(/^﻿/, '');
  if (/^\s*[{[]/.test(text)) return parseReplay(JSON.parse(text));
  if (/-BEGIN HEADER-/.test(text)) return parsePowerCSV(text);
  return parseSolarNavCSV(text);
}

// Interpolation linéaire d'un champ au temps t (heures depuis startDate), en ignorant les valeurs manquantes.
function interpField(records, t, key) {
  let lo = null, hi = null;
  for (const r of records) {
    if (r[key] === null) continue;
    if (r.t <= t) lo = r;
    if (r.t >= t) { hi = r; break; }
  }
  if (!lo && !hi) return null;
  if (!lo) return hi[key];
  if (!hi || hi.t === lo.t) return lo[key];
  return lo[key] + (hi[key] - lo[key]) * (t - lo.t) / (hi.t - lo.t);
}

function createReplaySource() {
  return {
    id: 'replay', label: 'Replay', data: null, fileName: null, days: 0,
    load(input, fileName) { this.data = parseReplay(input); this.fileName = fileName || null; this.days = this.data.days; return this.data; },
    read({ timeOfDay, day }) {
      const D = this.data; if (!D) return null;
      const t = (day % D.days) * 24 + timeOfDay;
      const date = new Date(Date.UTC(...D.startDate.split('-').map((x, i) => i === 1 ? x - 1 : +x)) + Math.floor(t / 24) * 86400000).toISOString().slice(0, 10);
      const sun = solarPosition(dayOfYear(date), timeOfDay, D.site.lat);
      const ghi = Math.max(0, interpField(D.records, t, 'ghi') ?? 0);
      const ghiClear = interpField(D.records, t, 'ghiClear');
      const hh = Math.floor(timeOfDay), mm = Math.floor((timeOfDay - hh) * 60);
      const { dni, dhi } = decomposeGHI(ghi, sun.elevDeg, dayOfYear(date));
      return {
        status: 'ok', sunElevDeg: sun.elevDeg, sunAzimuthDeg: sun.azimuthDeg, sunPos: null,
        sunSin: Math.sin(sun.elevDeg * Math.PI / 180), ghi, ghiClear, dni, dhi, albedo: REPLAY_ALBEDO,
        ambientC: interpField(D.records, t, 'tempC') ?? 20, windMs: Math.max(0, interpField(D.records, t, 'windMs') ?? 0),
        dustPct: interpField(D.records, t, 'dustPct'),
        cloudFactor: ghiClear > 20 ? Math.max(0, Math.min(1, ghi / ghiClear)) : null,
        datetime: `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      };
    },
  };
}

// ---------- Live ----------
// Les données temps réel viennent uniquement du backend FastAPI (GET /api/v1/data/live, URL relative : la page est
// servie par uvicorn). Le backend interroge Open-Meteo / JPL Horizons / NASA DONKI / NOAA SWPC, met en cache et
// se replie lui-même (dernière valeur → replay NASA POWER → simulation). Aucune API externe ni clé côté navigateur.
const LIVE_URL = '/api/v1/data/live';
const LIVE_VACUUM_AMBIENT_C = 25;   // Lune : pas d'air ; valeur nominale pour le modèle thermique des cellules
const LIVE_STATUS_RANK = { live: 0, cache: 1, fallback: 2 };

// Réponse /api/v1/data/live (snake_case, W/m², azimut boussole) → EnvironmentFrame de la page.
function frameFromLive(d) {
  const r = Math.PI / 180, w = d.weather, el = d.sun.elevation_deg;
  // Heure solaire locale du site (longitude / 15) ; sur la Lune, simple repère horaire UTC.
  const lst = new Date(Date.parse(d.generated_at) + d.site.lon_deg / 15 * 3600000);
  const solarHour = lst.getUTCHours() + lst.getUTCMinutes() / 60;
  return {
    status: 'ok', sunElevDeg: el, sunAzimuthDeg: d.sun.azimuth_deg, sunPos: null, sunSin: Math.sin(el * r),
    ghi: w.ghi_w_m2, ghiClear: w.ghi_clear_w_m2, dni: w.dni_w_m2, dhi: w.dhi_w_m2, albedo: w.albedo,
    ambientC: w.ambient_c ?? LIVE_VACUUM_AMBIENT_C, windMs: w.wind_m_s ?? 0, dustPct: null, cloudFactor: w.cloud_factor,
    datetime: lst.toISOString().slice(0, 16), solarHour,
    live: { body: d.site.body, site: d.site, generatedAt: d.generated_at, sources: [d.sun.source, d.weather.source], spaceWeather: d.space_weather },
  };
}

// Statut le plus dégradé parmi des métadonnées de source ('live' < 'cache' < 'fallback').
function worstLiveStatus(metas) {
  return metas.reduce((w, m) => LIVE_STATUS_RANK[m.status] > LIVE_STATUS_RANK[w] ? m.status : w, 'live');
}

function createLiveSource() {
  return {
    id: 'live', label: 'Live', body: 'earth', url: LIVE_URL, days: 1,
    periodMs: 30000, timeoutMs: 12000, maxAgeMs: 180000,   // le backend met en cache 5–15 min : 30 s suffisent
    latest: null, payload: null, receivedAt: 0, inFlight: false, lastRequestAt: -Infinity, lastError: null,
    // Page ouverte en file:// : pas de backend, donc pas d'appel (statut no-data, simulation affichée).
    available: typeof location !== 'undefined' && /^https?:$/.test(location.protocol),

    setBody(body) { this.body = body; this.latest = null; this.payload = null; this.lastError = null; this.lastRequestAt = -Infinity; },
    ingest(payload) { this.payload = payload; this.latest = frameFromLive(payload); this.receivedAt = performance.now(); this.lastError = null; },
    ageMs() { return this.latest ? performance.now() - this.receivedAt : null; },

    tick() {
      if (!this.available || this.inFlight || performance.now() - this.lastRequestAt < this.periodMs) return;
      this.inFlight = true; this.lastRequestAt = performance.now();
      const body = this.body, ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      fetch(`${this.url}?mode=${body}`, { signal: ctrl.signal })
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        .then(payload => { if (body === this.body) this.ingest(payload); })
        .catch(e => { this.lastError = e.name === 'AbortError' ? `backend : timeout (${this.timeoutMs} ms)` : 'backend : ' + (e.message || e); })
        .finally(() => { clearTimeout(timer); this.inFlight = false; });
    },

    // Dernier frame reçu tant qu'il est récent, sinon null (→ statut 'no-data', la page affiche la simulation).
    read() { this.tick(); return this.latest && this.ageMs() < this.maxAgeMs ? this.latest : null; },

    // 'live' | 'cache' | 'fallback' vu de la page : backend injoignable avec un frame encore valide ⇒ au moins 'cache'.
    status() {
      if (!this.latest) return null;
      const s = worstLiveStatus(this.latest.live.sources);
      return this.lastError && s === 'live' ? 'cache' : s;
    },
  };
}
