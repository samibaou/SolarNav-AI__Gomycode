// Test de non-régression SolarNav : lance Chrome headless, charge index.html,
// vérifie l'absence d'erreur JS et compare la production à tests/baseline.json.
//   node tests/run.mjs            -> compare à la baseline
//   node tests/run.mjs --update   -> réécrit la baseline
//   node tests/run.mjs --shot=out.png [--eval="js"]  -> capture d'écran (après eval optionnel)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const baselinePath = join(here, 'baseline.json');
const TOL = 1e-6;

const chromePaths = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const chromeExe = chromePaths.find(existsSync);
if (!chromeExe) { console.error('Chrome/Edge introuvable'); process.exit(2); }

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(chromeExe, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'solarnav-'))}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1400,900', '--no-first-run', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Faux backend /api/v1 pour tester le mode 'api' : chaque préfixe (/ok, /mismatch, /stow, /slow, /err, /bad) sert
// POST <préfixe>/agent/decision (Decision de contracts.py) et GET <préfixe>/analysis (AnalysisBundle).
const received = [];
const DECISION = (o = {}) => ({ action: 'MOVE', target_tilt_deg: 20, target_azimuth_deg: 180, reason: 'Gain net 12,4 Wh sur 30 min.', explanation_source: 'template', ...o });
const ANALYSIS = (phys, ml, conf, status) => ({ physics: { expected_power_w: phys, incidence_angle_deg: 10, effective_illumination: 0.9 },
  ml: { predicted_power_w: ml, model_name: 'rf', confidence: conf }, diagnostic: { status, performance_gap_pct: 0, message: 'ok' } });
const mock = createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Private-Network': 'true' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    received.push({ path: req.url, method: req.method, body });
    const send = (code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const [, prefix, route] = req.url.match(/^\/(\w+)\/(agent\/decision|analysis)$/) || [];
    const isDecision = route === 'agent/decision';
    if (!prefix) send(404, {});
    else if (isDecision && req.method !== 'POST') send(405, {});
    else if (prefix === 'slow') setTimeout(() => send(200, isDecision ? DECISION() : ANALYSIS(500, 480, 0.9, 'OK')), 3000);
    else if (prefix === 'err') send(500, { detail: 'boom' });
    else if (prefix === 'bad') send(200, isDecision ? { action: 'JUMP', target_tilt_deg: 1, target_azimuth_deg: 1 } : ANALYSIS(500, 480, 0.9, 'OK'));
    else if (prefix === 'stow') send(200, isDecision ? DECISION({ action: 'STOW', target_tilt_deg: 0, target_azimuth_deg: 180, reason: 'Mise en sécurité.' }) : ANALYSIS(500, 480, 0.9, 'OK'));
    else if (prefix === 'mismatch') send(200, isDecision ? DECISION() : ANALYSIS(500, 200, 0.6, 'ANOMALY'));
    else send(200, isDecision ? DECISION() : ANALYSIS(500, 480, 0.9, 'OK'));
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
// Port fermé (serveur ouvert puis fermé) pour simuler un backend injoignable.
const closed = createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r));
const DOWN = `http://127.0.0.1:${closed.address().port}`; await new Promise(r => closed.close(r));
// Échecs réseau provoqués volontairement par les tests : attendus dans la console du navigateur.
const EXPECTED_NET_ERRORS = [MOCK + '/err/agent/decision', MOCK + '/err/analysis', DOWN + '/agent/decision', DOWN + '/analysis'];
let ws, msgId = 0; const pending = new Map(); const errors = []; const events = [];

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; }); break; }
    } catch { }
    await sleep(200);
  }
  if (!ws) throw new Error('Connexion CDP impossible');
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    events.push(m.method);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !EXPECTED_NET_ERRORS.includes(m.params.entry.url)) errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  };
}
const send = (method, params = {}) => new Promise(res => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('Eval: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result.result.value;
}

// Scénarios déterministes : heure x météo x suivi. Lit `sim` si présent, sinon recalcule avec l'API d'origine.
const SCENARIOS = `(() => {
  P.autoTime = false; const out = [];
  if (typeof setDataSource === 'function') setDataSource('simulation');
  for (const tracking of [true, false]) for (const weather of ['clear', 'partly', 'overcast']) for (const t of [6.5, 9, 12, 15, 17.5]) {
    P.tracking = tracking; applyWeather(weather); P.timeOfDay = t;
    if (typeof resetForTest === 'function') resetForTest();
    updateSunAndSky(); updateStation();
    let panelsKW;
    if (typeof sim !== 'undefined') panelsKW = sim.panels.map(p => p.powerKW);
    else {
      const elev = Math.max(0, lastSin);
      const optimalTilt = lastElevDeg > 1 ? clamp(90 - lastElevDeg, 5, 85) : 35;
      const eff = P.tracking ? optimalTilt : P.globalTilt;
      const cf = 1 - Math.min(0.75, (cloudsGroup.children.length / 13) * 0.75);
      panelsKW = panels.map(p => computePower(p, p.manual ? p.tiltDeg : eff, cf, elev));
    }
    out.push({ key: (tracking ? 'track' : 'fixed') + '/' + weather + '/' + t + 'h', panelsKW, totalKW: panelsKW.reduce((a, b) => a + b, 0), shown: $('s-power').textContent });
  }
  P.tracking = true; applyWeather('clear');   // état par défaut pour les captures qui suivent
  return out;
})()`;

let failed = false;
const fail = msg => { failed = true; console.log('  ✗ ' + msg); };
const ok = msg => console.log('  ✓ ' + msg);
try {
  await connect();
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  const url = pathToFileURL(join(root, 'index.html')).href;
  await send('Page.navigate', { url });
  for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); i++) await sleep(100);
  await sleep(1500);

  console.log('Chargement');
  (await evaluate(`typeof THREE !== 'undefined' && THREE.REVISION`)) ? ok('Three.js chargé') : fail('Three.js absent (réseau/CDN ?)');
  // Les premières images compilent les shaders (lent en rendu logiciel headless) : on laisse jusqu'à 10 s.
  const t0 = await evaluate(`clock.elapsedTime`); let t1 = t0;
  for (let i = 0; i < 40 && t1 <= t0; i++) { await sleep(250); t1 = await evaluate(`clock.elapsedTime`); }
  t1 > t0 ? ok('boucle de rendu active') : fail('boucle de rendu figée');
  (await evaluate(`document.querySelectorAll('#scene canvas').length === 1`)) ? ok('canvas WebGL présent') : fail('canvas absent');

  console.log('Interactions UI');
  try {
    await evaluate(`(() => { document.querySelectorAll('[data-preset]').forEach(c => c.click()); document.querySelectorAll('[data-time]').forEach(c => c.click());
      $('t-track').click(); $('t-track').click(); $('b-reset').click(); document.querySelectorAll('.sec h2').forEach(h => { h.click(); h.click(); }); })()`);
    ok('clics sur les contrôles du dock');
  } catch (e) { fail(e.message.split('\n')[0]); }
  try {
    await evaluate(`(() => { selectPanel(panels[0]); selectPanel(panels[1]); deselectPanel(); selectPanel(panels[0]); })()`);
    ok('sélection / changement / désélection de panneaux');
  } catch (e) { fail(e.message.split('\n')[0]); }
  try {
    const r = await evaluate(`(() => { P.autoTime = false; P.timeOfDay = 10; P.tracking = false; updateSunAndSky(); updateStation();
      selectPanel(panels[0]); const s = $('p-tilt'); s.value = 70; s.dispatchEvent(new Event('input'));
      $('p-reset').click(); const r = { slider: +$('p-tilt').value, label: $('p-vtilt').textContent, manual: panels[0].manual, expected: P.globalTilt };
      deselectPanel(); P.tracking = true; return r; })()`);
    (!r.manual && r.slider === r.expected && r.label === r.expected + '°') ? ok('Réinitialiser remet le curseur du popup à jour')
      : fail(`Réinitialiser : curseur=${r.slider} libellé=${r.label} attendu=${r.expected}`);
  } catch (e) { fail(e.message.split('\n')[0]); }
  await sleep(300);

  console.log('Physique');
  const phys = await evaluate(`(() => { const saved = [P.tracking, P.timeOfDay, weatherPreset]; P.autoTime = false; applyWeather('clear'); const out = [];
    for (let t = 7; t <= 17; t += 0.5) { P.timeOfDay = t;
      if (typeof resetForTest === 'function') resetForTest();
      P.tracking = true; updateSunAndSky(); updateStation(); const tr = sim.totalKW, inc = Math.min(...sim.panels.map(p => p.incidence));
      P.tracking = false; updateStation(); out.push({ t, tr, fixed: sim.totalKW, inc }); }
    P.tracking = saved[0]; P.timeOfDay = saved[1]; applyWeather(saved[2]); return out; })()`);
  if (phys.every(x => x.tr >= x.fixed - 1e-9)) ok('suivi ≥ fixe à chaque demi-heure de 7h à 17h');
  else fail('suivi < fixe à ' + phys.filter(x => x.tr < x.fixed - 1e-9).map(x => x.t + 'h').join(', '));
  if (phys.every(x => x.inc > 0.999)) ok('suivi 2 axes : incidence ≈ 1 toute la journée');
  else fail('incidence du suivi < 0.999 à ' + phys.filter(x => x.inc <= 0.999).map(x => x.t + 'h').join(', '));
  const at = h => phys.find(x => x.t === h).tr;
  Math.abs(at(9) - at(15)) < 0.05 * at(12) ? ok(`production symétrique matin/après-midi (9h ${at(9).toFixed(2)} / 15h ${at(15).toFixed(2)} kW)`)
    : fail(`asymétrie 9h ${at(9).toFixed(2)} vs 15h ${at(15).toFixed(2)} kW`);

  if (await evaluate(`typeof sensors !== 'undefined'`)) {
    console.log('Capteurs');
    const c = await evaluate(`(() => { const saved = [P.timeOfDay, P.wind, P.tempEffect]; P.autoTime = false; resetForTest(); sensorFaults.clearAll();
      const r = {};
      // Jour clair, midi : tout doit être OK, valeurs proches de la vérité
      P.timeOfDay = 12; P.wind = 1; applyWeather('clear'); updateSunAndSky(); updateStation(); sampleSensors();
      r.count = sensors.length; r.types = [...new Set(sensors.map(s => s.id.replace(/^p\\d\\./, 'p*.')))].sort().join(',');
      r.allOkNoon = sensors.filter(s => s.state !== 'OK').map(s => s.id + ':' + s.state + ' ' + s.value);
      r.pyrErr = Math.abs(sensorById('pyr').value - sim.env.ghi) / sim.env.ghi;
      r.domRows = document.querySelectorAll('#sensor-list .sensor').length;
      renderSensorUI(); r.valText = sensorById('pyr').dom.val.textContent;
      // Vent : le refroidissement baisse la température de cellule
      const env = () => { updateSunAndSky(); updateStation(); };   // l'environnement est lu via la source dans updateSunAndSky
      P.wind = 0; env(); const hot = sim.panels[0].cellC; P.wind = 3; env(); const cool = sim.panels[0].cellC; r.windCools = cool < hot - 5;
      P.wind = 0; env(); sampleSensors(); r.hotState = sensorById('p0.temp').state; r.hotC = sim.panels[0].cellC; P.wind = 1; env();
      // Effet thermique : désactivé -> plus de production
      updateStation(); const withT = sim.totalKW; P.tempEffect = false; updateStation(); r.tempEffect = sim.totalKW > withT; P.tempEffect = true;
      // Poussière : s'accumule avec le temps et le vent, réduit la production, nettoyage
      updateStation(); const clean = sim.panels[0].powerKW; stepSimulation(48); updateStation();
      r.dust24h = sim.panels[0].dust; r.dustLoss = sim.panels[0].powerKW < clean; sampleSensors(); r.dustState = sensorById('p0.dust').state;
      r.powerState = sensorById('p0.power').state; cleanPanels(); r.cleaned = panels.every(p => p.dust === 0);
      resetForTest(); P.wind = 3; env(); stepSimulation(48); r.windierDust = panels[0].dust > r.dust24h; resetForTest(); P.wind = 1; env();
      // Batterie : charge à midi, décharge la nuit
      updateStation(); let s0 = sim.battery.socPct; stepSimulation(1); r.chargesNoon = sim.battery.socPct > s0;
      P.timeOfDay = 22; updateSunAndSky(); updateStation(); s0 = sim.battery.socPct; stepSimulation(1); r.dischargesNight = sim.battery.socPct < s0;
      // Pannes (API seulement)
      P.timeOfDay = 12; updateSunAndSky(); updateStation(); resetForTest();
      sensorFaults.inject('pyr', 'dropout'); sampleSensors(); r.dropout = sensorById('pyr').state + '/' + sensorById('pyr').value;
      sensorFaults.inject('p1.temp', 'stuck'); for (let i = 0; i < 7; i++) sampleSensors(); r.stuck = sensorById('p1.temp').state + ':' + sensorById('p1.temp').note;
      sensorFaults.inject('total', 'drift', { ratePerMin: 60 }); const d0 = performance.now(); sensorById('total').fault.since = d0 - 60000; sampleSensors();
      r.drift = sensorById('total').value - sim.totalKW; r.active = sensorFaults.active().length;
      let threw = false; try { sensorFaults.inject('nope', 'stuck'); } catch { threw = true; } r.badIdThrows = threw;
      sensorFaults.clearAll(); for (let i = 0; i < 7; i++) sampleSensors(); r.recovered = sensors.every(s => s.state === 'OK');
      selectPanel(panels[2]); r.popupRows = document.querySelectorAll('#p-sensors .psens').length; deselectPanel();
      P.timeOfDay = saved[0]; P.wind = saved[1]; P.tempEffect = saved[2]; resetForTest(); return r; })()`);
    const chk = (cond, msg) => cond ? ok(msg) : fail(msg);
    chk(c.count === 16 && c.types === 'anemo,batt,p*.dust,p*.power,p*.temp,pyr,total', `16 capteurs (${c.types})`);
    chk(c.allOkNoon.length === 0, 'tous OK à midi par ciel clair' + (c.allOkNoon.length ? ' — ' + c.allOkNoon.join(', ') : ''));
    chk(c.pyrErr < 0.05, `bruit léger (pyranomètre ${(c.pyrErr * 100).toFixed(2)} %)`);
    chk(c.domRows === 16 && /W\/m²$/.test(c.valText), `section Capteurs rendue (${c.domRows} lignes, « ${c.valText} »)`);
    chk(c.windCools, 'le vent refroidit les cellules');
    chk(c.hotState !== 'OK', `sans vent à midi : ${c.hotC.toFixed(1)} °C → ${c.hotState}`);
    chk(c.tempEffect, 'pertes thermiques actives par défaut');
    chk(c.dust24h > 5 && c.dustLoss && c.dustState !== 'OK', `poussière 48h =${c.dust24h.toFixed(1)} % → ${c.dustState}, wattmètre ${c.powerState}, production réduite`);
    chk(c.windierDust, 'plus de vent → plus de poussière');
    chk(c.cleaned, 'nettoyage remet la poussière à 0');
    chk(c.chargesNoon && c.dischargesNight, 'batterie : charge à midi, décharge la nuit');
    chk(c.dropout === 'FAULT/null', 'panne « perte de signal » → FAULT');
    chk(c.stuck === 'WARNING:valeur figée', 'panne « capteur bloqué » → WARNING valeur figée');
    chk(Math.abs(c.drift - 60) < 1 && c.active === 3, `panne « dérive » : +${c.drift.toFixed(2)} après 1 min`);
    chk(c.badIdThrows, 'injection sur un capteur inconnu refusée');
    chk(c.recovered, 'retour à OK après suppression des pannes');
    chk(c.popupRows === 3, 'mesures affichées dans le popup');
  }

  if (await evaluate(`typeof setViewMode === 'function'`)) {
    console.log('Rendu');
    const v = await evaluate(`(() => { const r = {}; P.autoTime = false; resetForTest(); P.timeOfDay = 10; applyWeather('clear'); updateSunAndSky(); updateStation();
      updateEnvMap(); r.env = !!(scene.environment && scene.environment.isTexture); const tex1 = scene.environment; updateEnvMap(); r.envReplaced = scene.environment !== tex1;
      r.maps = panels.every(p => p.pv.material.map === cellTex) && cellTex.image.width === 1024;
      r.ownMats = new Set(panels.map(p => p.pv.material)).size === panels.length;
      r.normal = panels.every(p => p.pv.material.color.getHex() === PV_COLOR);
      document.querySelector('[data-view=power]').click(); panels[1].dust = 100; updateStation(); updateHeatmap();
      r.legend = getComputedStyle($('heat-legend')).display + ' ' + $('hl-max').textContent;
      r.powerDiffers = panels[0].pv.material.emissive.getHex() !== panels[1].pv.material.emissive.getHex();
      r.brighterMorePower = panels[0].pv.material.emissive.getHSL({}).l > panels[1].pv.material.emissive.getHSL({}).l;
      document.querySelector('[data-view=temp]').click(); r.tempLegend = $('hl-max').textContent;
      document.querySelector('[data-view=normal]').click(); r.backNormal = panels.every(p => { const m = p.pv.material;
        return m.color.getHex() === PV_COLOR && m.emissive.getHex() === 0 && m.emissiveMap === null && m.toneMapped && m.envMapIntensity === pvMat.envMapIntensity; });
      r.legendHidden = getComputedStyle($('heat-legend')).display === 'none';
      // Luminosité réelle du rendu (garde-fou écran noir) : grille de pixels sur la moitié basse (sol + panneaux), vue par défaut à 10h
      camera.position.set(22, 14, 28); controls.target.set(0, 0, 0); controls.update(); updateEnvMap(); renderer.render(scene, camera);
      const gl = renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, px = new Uint8Array(4); let sum = 0, n = 0;
      for (let i = 1; i < 8; i++) for (let j = 1; j < 4; j++) { gl.readPixels(Math.floor(W * i / 8), Math.floor(H * j / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); sum += (px[0] + px[1] + px[2]) / 3; n++; }
      r.luma = sum / n;
      resetForTest(); return r; })()`);
    const chk = (cond, msg) => cond ? ok(msg) : fail(msg);
    chk(v.luma > 100, `rendu non noir en journée (luminance moyenne ${v.luma.toFixed(0)}/255)`);
    chk(v.env && v.envReplaced, 'env map PMREM générée et régénérable');
    chk(v.maps && v.ownMats, 'texture de cellules sur les 4 panneaux (matériaux distincts)');
    chk(v.normal, 'couleur normale conservée');
    chk(v.legend === 'flex 5.5 kW' && v.powerDiffers && v.brighterMorePower, 'heatmap production : légende, panneau sale plus sombre');
    chk(v.tempLegend === '80 °C', 'heatmap température : légende');
    chk(v.backNormal && v.legendHidden, 'retour au mode normal');
  }

  if (await evaluate(`typeof setDataSource === 'function'`)) {
    console.log('Sources de données');
    const d = await evaluate(`(() => { const r = {}; P.autoTime = false; resetForTest();
      // Parseurs : CSV SolarNav, CSV NASA POWER (valeur manquante -999), JSON SolarNav
      const csv = parseReplay('# name=Test\\n# lat=31\\n# lon=-7\\ndate,hour,ghi,tempC,windMs,dustPct\\n2024-06-01,12,900,30,5,12\\n2024-06-01,13,800,31,6,12');
      r.csv = csv.site.name + ' ' + csv.site.lat + ' ' + csv.records.length + ' ' + csv.records[1].dustPct;
      const pcsv = parseReplay('-BEGIN HEADER-\\nLocation: Latitude  30.99   Longitude -6.86\\n-END HEADER-\\nYEAR,MO,DY,HR,ALLSKY_SFC_SW_DWN,T2M,WS10M\\n2024,6,18,11,-999,30,4\\n2024,6,18,12,850,31,4');
      r.pcsv = pcsv.site.lat + ' ' + pcsv.records[0].ghi + ' ' + interpField(pcsv.records, 11, 'ghi');
      r.json = parseReplay({ site: { name: 'J', lat: 10, lon: 0 }, records: [{ date: '2024-01-01', hour: 0, ghi: 0, tempC: 5, windMs: 1 }] }).site.name;
      try { parseReplay('date,hour,foo\\n2024-01-01,1,2'); r.badRejected = false; } catch (e) { r.badRejected = e.message; }
      // Replay NASA POWER Ouarzazate
      setDataSource('replay'); r.loaded = !!DATA_SOURCES.replay.data; r.days = DATA_SOURCES.replay.data?.days;
      dataDay = 1; P.timeOfDay = 12; updateSunAndSky(); updateStation();
      const p = window.SOLARNAV_SAMPLE_REPLAY.properties.parameter;
      r.ghi = sim.env.ghi; r.ghiExp = p.ALLSKY_SFC_SW_DWN['2024061912']; r.temp = sim.env.ambientC; r.tempExp = p.T2M['2024061912'];
      r.wind = sim.env.windMs; r.windExp = p.WS10M['2024061912'];
      r.elev = sim.sun.elevDeg; r.azNoon = sim.sun.azimuthDeg; r.kw = sim.totalKW; r.dt = sim.data.datetime; r.status = sim.data.status;
      P.timeOfDay = 12.5; updateSunAndSky(); r.interp = sim.env.ghi; r.interpExp = (p.ALLSKY_SFC_SW_DWN['2024061912'] + p.ALLSKY_SFC_SW_DWN['2024061913']) / 2;
      P.timeOfDay = 8; updateSunAndSky(); r.azMorning = sim.sun.azimuthDeg; r.sunEast = sim.sun.pos.x > 0;
      P.timeOfDay = 5.5; updateSunAndSky(); updateStation(); r.dawnKW = sim.totalKW; r.dawnDiffuse = sim.env.dhi > 0;
      P.timeOfDay = 2; updateSunAndSky(); updateStation(); r.nightKW = sim.totalKW;
      r.locked = $('i-wind').classList.contains('locked') && document.querySelector('[data-preset]').classList.contains('locked');
      renderDataInfo(); r.badge = $('s-data').textContent;
      // Live vide
      setDataSource('live'); P.timeOfDay = 12; updateSunAndSky(); updateStation(); r.live = sim.data.status + ' ' + $('s-data').textContent + ' ' + (sim.totalKW > 0);
      // Retour simulation
      setDataSource('simulation'); r.unlocked = !$('i-wind').classList.contains('locked'); r.simStatus = sim.data.status;
      // Fichier invalide
      loadReplay('nimporte quoi', 'x.csv'); r.fileErr = $('src-info').textContent.includes('Fichier refusé');
      resetForTest(); return r; })()`);
    const chk = (cond, msg) => cond ? ok(msg) : fail(msg);
    chk(d.csv === 'Test 31 2 12', `CSV SolarNav (${d.csv})`);
    chk(d.pcsv === '30.99 null 850', `CSV NASA POWER, -999 ignoré (${d.pcsv})`);
    chk(d.json === 'J', 'JSON SolarNav');
    chk(typeof d.badRejected === 'string', `fichier sans colonnes requises refusé (${d.badRejected})`);
    chk(d.loaded && d.days === 7, `exemple NASA POWER chargé (${d.days} jours)`);
    chk(Math.abs(d.ghi - d.ghiExp) < 1e-6 && Math.abs(d.temp - d.tempExp) < 1e-6 && Math.abs(d.wind - d.windExp) < 1e-6,
      `19/06 12h = relevé NASA (GHI ${d.ghi.toFixed(0)} W/m², ${d.temp.toFixed(1)} °C, ${d.wind.toFixed(1)} m/s)`);
    chk(Math.abs(d.interp - d.interpExp) < 1e-6, 'interpolation linéaire entre relevés');
    chk(Math.abs(d.elev - 82.4) < 1.5 && (d.azNoon < 5 || d.azNoon > 355 || Math.abs(d.azNoon - 180) < 5), `soleil à midi solaire : élévation ${d.elev.toFixed(1)}° (attendu ≈ 82,4°)`);
    chk(d.azMorning > 60 && d.azMorning < 110 && d.sunEast, `soleil à l'est le matin (azimut ${d.azMorning.toFixed(0)}°)`);
    chk(d.kw > 12 && d.kw <= 22 + 1e-9 && d.nightKW === 0, `production replay plausible (${d.kw.toFixed(1)} kW à midi, 0 la nuit)`);
    chk(d.dawnKW < 0.5 * d.kw && d.dawnDiffuse, `aube réaliste : ${d.dawnKW.toFixed(1)} kW à 5h30 (décomposition Erbs + ciel clair)`);
    chk(d.dt === '2024-06-19T12:00' && d.status === 'ok' && d.badge === 'Replay 19/06', `horodatage ${d.dt}, badge « ${d.badge} »`);
    chk(d.locked && d.unlocked, 'curseurs météo verrouillés hors simulation, déverrouillés au retour');
    chk(d.live === 'no-data Live ∅ true', `live vide → statut no-data, simulation affichée (${d.live})`);
    chk(d.simStatus === 'ok' && d.fileErr, 'retour simulation OK, fichier invalide signalé');
  }

  if (await evaluate(`typeof frameFromLive === 'function'`)) {
    console.log('Live (backend /api/v1/data/live)');
    // Page en file:// : pas de backend. On injecte des réponses au format de la route (aucun appel réseau).
    const lv = await evaluate(`(() => { const r = {}; P.autoTime = false; P.tracking = true; P.wind = 1; resetForTest();
      const L = DATA_SOURCES.live;
      // Réponses /api/v1/data/live simulées, réutilisées par les sections suivantes (window.T).
      window.T = (() => { const now = new Date().toISOString();
        const meta = (id, label, status, age, extra = {}) => ({ id, label, status, updated_at: now, observed_at: null, age_s: age, error: null, ...extra });
        const calm = { level: 'none', risk_flags: [], recommended_action: null, validation_gate: 'operator', reasons: [],
          xray_flux_w_m2: 6.9e-7, xray_class: 'B6.9', solar_wind_speed_km_s: 396.3, solar_wind_density_cm3: 1.3, imf_bz_nt: -2.07,
          max_kp_24h: null, flares_24h: [], sources: [meta('swpc_xrays', 'NOAA SWPC · rayons X', 'live', 30)] };
        const strong = { ...calm, level: 'strong', risk_flags: ['SPACE_WEATHER'], recommended_action: 'STOW', reasons: ['Flux X X2.1'] };
        const payload = (o = {}) => ({ schema_version: '1.0', mode: 'earth', generated_at: '2026-09-27T12:30:00Z',
          site: { name: 'Ouarzazate — Noor', body: 'earth', lat_deg: 30.92, lon_deg: -6.89 },
          sun: { azimuth_deg: 180, elevation_deg: 60, source: meta('noaa_solar_calc', 'Éphéméride NOAA (calcul)', 'live', 0) },
          weather: { ghi_w_m2: 900, dni_w_m2: 850, dhi_w_m2: 100, ghi_clear_w_m2: 950, albedo: 0.25, ambient_c: 31, wind_m_s: 2,
            cloud_factor: 0.95, source: meta('open_meteo', 'Open-Meteo', 'live', 180) }, space_weather: calm, ...o });
        const moon = (el, o = {}) => payload({ mode: 'moon', site: { name: 'Pôle Sud lunaire', body: 'moon', lat_deg: -89.9, lon_deg: 0 },
          sun: { azimuth_deg: 344.4, elevation_deg: el, source: meta('jpl_horizons', 'JPL Horizons', 'live', 60) },
          weather: { ghi_w_m2: Math.max(0, 1361 * Math.sin(el * Math.PI / 180)), dni_w_m2: el > 0 ? 1361 : 0, dhi_w_m2: 0, ghi_clear_w_m2: null, albedo: 0.12,
            ambient_c: null, wind_m_s: 0, cloud_factor: 1, source: meta('airless_model', 'Vide spatial · soleil JPL Horizons', 'live', 60) }, ...o });
        return { meta, calm, strong, payload, moon };
      })();
      const { meta, calm, strong, payload } = T;
      const step = () => { updateSunAndSky(); updateStation(); renderDataInfo(); renderDecisionInfo(); };
      r.noFetch = L.available === false;
      setDataSource('live'); L.ingest(payload()); step();
      r.env = [sim.sun.elevDeg, sim.sun.azimuthDeg, sim.env.ghi, sim.env.dni, sim.env.dhi, sim.env.ambientC, sim.env.windMs].join(',');
      r.hour = P.timeOfDay.toFixed(2); r.dt = sim.data.datetime; r.kw = sim.totalKW;
      r.badge = $('s-data').textContent; r.info = $('src-info').textContent;
      r.state = JSON.stringify(buildDecisionState().spaceWeather);
      // Backend injoignable, dernier frame encore valide → Cache ; statut de repli du backend → Secours
      L.lastError = 'backend : HTTP 502'; renderDataInfo(); r.cache = $('s-data').textContent + ' ' + $('src-info').textContent.includes('dernières données conservées');
      L.lastError = null;
      L.ingest(payload({ weather: { ...payload().weather, source: meta('nasa_power_replay', 'NASA POWER (replay 18/06–24/06/2024)', 'fallback', 0, { error: 'timeout' }) } }));
      step(); r.fallback = $('s-data').textContent + ' ' + $('src-info').textContent.includes('NASA POWER');
      // Alerte forte (Full auto par défaut) : STOW à plat, drapeau SPACE_WEATHER, reason explicite ; retour au calme
      L.ingest(payload({ space_weather: strong })); step();
      r.storm = sim.decisions.map(d => d.action + ':' + d.riskFlags.includes('SPACE_WEATHER')).join(',') + ' ' + sim.panels.every(p => p.tiltDeg === CONSTRAINTS.stowTiltDeg);
      r.stormReason = sim.decisions[0].reason;
      L.ingest(payload()); step(); r.calmAgain = sim.decisions.map(d => d.action).join(',');
      // Lune
      setLiveBody('moon'); L.ingest(T.moon(1.5, { space_weather: { ...strong, validation_gate: 'auto' } })); step();
      r.moon = sim.decisions.map(d => d.action).join(',') + ' ' + $('src-info').textContent.includes('JPL Horizons') + ' ' + sim.env.ambientC;
      // Nettoyage
      setLiveBody('earth'); setDataSource('simulation'); resetForTest(); step();
      r.cleanup = sim.data.live === null && buildDecisionState().spaceWeather === null;
      return r; })()`);
    const chk = (cond, msg) => cond ? ok(msg) : fail(msg);
    chk(lv.noFetch, 'file:// : aucune requête vers le backend');
    chk(lv.env === '60,180,900,850,100,31,2', `frame live = réponse backend (${lv.env})`);
    chk(lv.hour === '12.03' && lv.dt === '2026-09-27T12:02' && lv.kw > 10, `heure solaire réelle du site imposée (${lv.hour} h, ${lv.dt}, ${lv.kw.toFixed(1)} kW)`);
    chk(lv.badge === 'Live' && lv.info.includes('Open-Meteo · il y a 3 min') && lv.info.includes('Éphéméride NOAA') && lv.info.includes('NOAA SWPC'),
      'badge Live, « Open-Meteo · il y a 3 min », sources météo spatiale listées');
    chk(lv.state === '{"level":"none","riskFlags":[],"recommendedAction":null,"reasons":[]}', 'spaceWeather dans l’état de décision');
    chk(lv.cache === 'Cache true', `backend injoignable → Cache, dernières données conservées (${lv.cache})`);
    chk(lv.fallback === 'Secours true', `repli backend (replay NASA POWER) → Secours (${lv.fallback})`);
    chk(lv.storm === 'STOW:true,STOW:true,STOW:true,STOW:true true' && lv.stormReason.startsWith('Tempête solaire forte'), `alerte forte → STOW à plat, SPACE_WEATHER (« ${lv.stormReason} »)`);
    chk(lv.calmAgain === 'MOVE,MOVE,MOVE,MOVE', `alerte retombée → suivi repris (${lv.calmAgain})`);
    chk(lv.moon === 'STOW,STOW,STOW,STOW true 25', `Lune : source JPL Horizons, tempête solaire → STOW (${lv.moon})`);
    chk(lv.cleanup, 'retour simulation : plus de données live');
  }

  if (await evaluate(`typeof decisionProvider !== 'undefined'`)) {
    console.log('Décision (politique locale + backend /api/v1/agent/decision)');
    const q = await evaluate(`(async () => { const r = {}; P.autoTime = false; P.tracking = true; P.wind = 1; setDataSource('simulation'); applyWeather('clear'); resetForTest();
      const step = () => { updateSunAndSky(); updateStation(); };
      const az = i => compassOfYaw(sim.panels[i].orientation), dp = decisionProvider, L = DATA_SOURCES.live;
      dp.periodMs = 1e12;   // pas d'appel de fond par la boucle d'animation pendant les await du test (sinon course)
      P.timeOfDay = 10; step(); step();
      // Local
      const st = buildDecisionState(); r.keys = Object.keys(st).join(',');
      r.json = JSON.stringify(st).length > 500 && JSON.parse(JSON.stringify(st)).panels.length === 4;
      const loc = decideLocal(st);
      r.local = loc.map(d => d.action + '/' + d.source).join(','); r.shape = Object.keys(loc[0]).join(','); r.reason = loc[0].reason;
      r.sunAligned = Math.abs(az(0) - sim.sun.azimuthDeg) < 1e-6 && Math.abs(sim.panels[0].tiltDeg - (90 - sim.sun.elevDeg)) < 1e-6;
      renderDecisionInfo(); r.badgeLocal = $('s-dec').textContent;
      // Nuit et vent fort → STOW
      P.timeOfDay = 23; step(); r.night = sim.decisions.map(d => d.action).join(',') + ' ' + sim.panels[0].tiltDeg + ' ' + sim.decisions[0].riskFlags.join('|');
      P.timeOfDay = 12; P.wind = 3; step(); r.wind = sim.decisions[0].action + ' ' + sim.decisions[0].riskFlags.join('|'); P.wind = 1; step();
      // Suivi coupé
      P.tracking = false; step(); r.manual = sim.decisions.map(d => d.source).join(','); renderDecisionInfo(); r.badgeManual = $('s-dec').textContent; P.tracking = true;
      // API hors Live : aucun appel, repli local avec avertissement
      setDecisionMode('api'); dp.client.base = '${MOCK}/ok'; step(); dp.periodMs = 0; dp.tick(lastDecisionState); dp.periodMs = 1e12;
      r.notLiveCall = dp.inFlight; step(); renderDecisionInfo();
      r.notLive = sim.decisions[0].source + ' ' + $('dec-info').textContent.includes('seulement en source Live');
      // API en Live : décision du backend appliquée aux 4 panneaux
      setDataSource('live'); L.ingest(T.payload()); step();
      let t0 = performance.now(); await dp.refresh(); step();
      r.ai = sim.decisions.map(d => d.source).join(','); r.applied = sim.panels.map((p, i) => Math.round(p.tiltDeg) + '/' + Math.round(az(i))).join(',');
      r.aiFlags = sim.decisions[0].riskFlags.join('|'); r.aiUnc = sim.decisions[0].uncertainty; r.aiReason = sim.decisions[0].reason;
      renderDecisionInfo(); r.badgeAI = $('s-dec').textContent; r.latency = dp.lastLatencyMs; r.infoReason = $('dec-info').textContent.includes('Gain net 12,4 Wh');
      r.noWarning = !$('dec-info').textContent.includes('seulement en source Live');
      selectPanel(panels[0]); r.popup = $('p-dsrc').textContent + ' ' + $('p-dec').textContent; deselectPanel();
      // Analyse : désaccord physique/ML + diagnostic → drapeaux, incertitude = 1 − confiance
      dp.client.base = '${MOCK}/mismatch'; await dp.refresh(); step(); r.mismatch = sim.decisions[0].riskFlags.join('|') + ' ' + sim.decisions[0].uncertainty;
      // STOW du backend
      dp.client.base = '${MOCK}/stow'; await dp.refresh(); step(); r.stow = sim.decisions.map(d => d.action).join(',') + ' ' + sim.panels[0].tiltDeg;
      // Sécurité locale prioritaire sur le backend : vent fort
      dp.client.base = '${MOCK}/ok'; await dp.refresh(); L.ingest(T.payload({ weather: { ...T.payload().weather, wind_m_s: 13 } })); step();
      r.safety = sim.decisions[0].action + '/' + sim.decisions[0].source + ' ' + sim.decisions[0].riskFlags.join('|');
      L.ingest(T.payload()); step();
      // Réponse périmée → secours
      dp.latest.receivedAt -= 20000; step(); r.stale = sim.decisions[0].source;
      // Timeout, HTTP 500, réponse invalide, backend injoignable → secours local
      dp.client.base = '${MOCK}/slow'; dp.client.timeoutMs = 1000; dp.latest = null; t0 = performance.now();
      await dp.refresh(); r.slowMs = performance.now() - t0; step(); r.slow = sim.decisions[0].source + ' ' + dp.lastError; dp.client.timeoutMs = 5000;
      dp.client.base = '${MOCK}/err'; await dp.refresh(); step(); r.err = sim.decisions[0].source + ' ' + dp.lastError;
      dp.client.base = '${MOCK}/bad'; await dp.refresh(); step(); r.bad = sim.decisions[0].source + ' ' + dp.lastError;
      dp.client.base = '${DOWN}'; await dp.refresh(); step(); r.down = sim.decisions[0].source + ' ' + !!dp.lastError;
      renderDecisionInfo(); r.infoErr = $('dec-info').textContent.includes('secours local');
      // Validation du format Decision
      try { validateBackendDecision({ action: 'MOVE', target_tilt_deg: 'x', target_azimuth_deg: 1 }); r.v1 = 'accepté'; } catch (e) { r.v1 = e.message; }
      try { validateBackendDecision({ action: 'FLY', target_tilt_deg: 1, target_azimuth_deg: 1 }); r.v2 = 'accepté'; } catch (e) { r.v2 = e.message; }
      r.view = JSON.stringify(twinStateView({ timestamp: 't', sun: { azimuth_deg: 142, elevation_deg: 4.8 }, panel: { tilt_deg: 32, azimuth_deg: 120 },
        battery: { soc_pct: 41 }, environment: { illumination: 0.88, shadow_probability: 0.15, dust_factor: 0.95 }, energy: { observed_power_w: 400 } }));
      dp.client.base = BACKEND_BASE; dp.periodMs = 5000; setDecisionMode('local'); setDataSource('simulation'); step(); r.backLocal = sim.decisions[0].source;
      r.relative = createBackendClient().base;
      return r; })()`);
    const chk = (cond, msg) => cond ? ok(msg) : fail(msg);
    chk(q.keys === 'schemaVersion,simTimeHours,datetime,site,dataSource,sun,weather,station,panels,sensors,constraints,model,spaceWeather' && q.json, 'état JSON complet et sérialisable');
    chk(q.shape === 'panelId,action,targetTilt,targetAzimuth,expectedGainKW,uncertainty,riskFlags,reason,source', 'décision au format interne (avec reason)');
    chk(q.local === 'MOVE/fallback,MOVE/fallback,MOVE/fallback,MOVE/fallback' && q.sunAligned && q.badgeLocal === 'Secours' && q.reason.startsWith('Suivi solaire 2 axes'),
      `local : MOVE vers le soleil, source secours (« ${q.reason} »)`);
    chk(q.night === 'STOW,STOW,STOW,STOW 0 NIGHT', `nuit → STOW à plat (${q.night})`);
    chk(q.wind === 'STOW HIGH_WIND', `vent 12 m/s → ${q.wind}`);
    chk(q.manual === 'override,override,override,override' && q.badgeManual === 'Manuel', 'suivi désactivé → source manuel');
    chk(q.notLiveCall === false && q.notLive === 'fallback true', 'API hors source Live : aucun appel, repli local + avertissement visible');
    chk(q.ai === 'ai,ai,ai,ai' && q.applied === '20/180,20/180,20/180,20/180' && q.badgeAI === 'IA' && q.noWarning,
      `API en Live : décision backend appliquée aux 4 panneaux (${q.applied}, ${Math.round(q.latency)} ms)`);
    chk(q.aiReason === 'Gain net 12,4 Wh sur 30 min.' && q.infoReason && q.popup.includes('Gain net 12,4 Wh') && q.popup.startsWith('IA MOVE'), `reason du backend affiché (popup : « ${q.popup} »)`);
    chk(q.aiFlags === '' && Math.abs(q.aiUnc - 0.1) < 1e-9, `analyse cohérente : aucun drapeau, incertitude ${q.aiUnc}`);
    chk(q.mismatch === 'PHYSICS_ML_MISMATCH|DIAGNOSTIC_ALERT 0.4', `désaccord physique/ML + diagnostic → ${q.mismatch}`);
    chk(q.stow === 'STOW,STOW,STOW,STOW 0', `STOW du backend appliqué (${q.stow})`);
    chk(q.safety === 'STOW/fallback HIGH_WIND', `sécurité locale prioritaire sur le backend (${q.safety})`);
    chk(q.stale === 'fallback', 'réponse backend périmée (> 15 s) → secours');
    chk(q.slow.startsWith('fallback timeout') && q.slowMs >= 900 && q.slowMs < 1800, `timeout à ${Math.round(q.slowMs)} ms → secours`);
    chk(q.err === 'fallback HTTP 500', `HTTP 500 → ${q.err}`);
    chk(q.bad.startsWith('fallback') && q.bad.includes('action invalide'), `réponse invalide → ${q.bad}`);
    chk(q.down === 'fallback true' && q.infoErr, 'backend injoignable → secours, signalé dans l\'UI');
    chk(q.v1.includes('target_tilt_deg') && q.v2.includes('action invalide'), 'validation du format Decision (contracts.py)');
    chk(q.view === '{"timestamp":"t","sunElevDeg":4.8,"sunAzimuthDeg":142,"panelTiltDeg":32,"panelAzimuthDeg":120,"socPct":41,"dustPct":5.000000000000004,"observedKW":0.4}',
      'adaptateur TwinState : W → kW, dust_factor → dustPct');
    chk(q.backLocal === 'fallback' && q.relative === '/api/v1', 'retour au mode local ; client en URL relative /api/v1');
    const calls = received.filter(x => x.path === '/ok/agent/decision');
    chk(calls.length >= 1 && calls.every(c => c.method === 'POST' && c.body === ''), `POST /agent/decision sans corps (${calls.length} appels)`);
  }

  if (await evaluate(`typeof siteConstraints === 'function'`)) {
    console.log('Lune (seuil de nuit, décor)');
    const m = await evaluate(`(() => { const r = {}; P.autoTime = false; P.tracking = true; resetForTest(); const L = DATA_SOURCES.live;
      const step = () => { updateSunAndSky(); updateStation(); };
      setDataSource('live'); setLiveBody('moon');
      L.ingest(T.moon(0.5)); step();
      r.low = sim.decisions.map(d => d.action).join(',') + ' ' + buildDecisionState().constraints.minSunElevDeg + ' ' + Math.round(sim.panels[0].tiltDeg) + ' ' + (sim.totalKW > 0);
      L.ingest(T.moon(-0.5)); step(); r.grazing = sim.decisions[0].action + ' ' + sim.decisions[0].riskFlags.includes('NIGHT');
      L.ingest(T.moon(-1.3)); step();
      r.night = sim.decisions[0].action + ' ' + sim.decisions[0].riskFlags.join('|') + ' ' + sim.decisions[0].reason.includes('-1°');
      L.ingest(T.moon(1.5)); step();
      r.decor = [scenery.site ? scenery.site() : '?', scenery.terrain.visible, !!scenery.sky && scenery.sky.visible, skyDome.visible, cloudsGroup.visible, starMat.opacity, $('s-sky').textContent].join(',');
      r.light = sunLight.intensity === P.sunIntensity;
      setLiveBody('earth'); L.ingest(T.payload()); step();
      r.earth = [scenery.site ? scenery.site() : '?', scenery.terrain.visible, cloudsGroup.visible, buildDecisionState().constraints.minSunElevDeg].join(',');
      setDataSource('simulation'); step(); r.sim = scenery.site ? scenery.site() : '?';
      return r; })()`);
    const chk = (cond, msg) => cond ? ok(msg) : fail(msg);
    chk(m.low === 'MOVE,MOVE,MOVE,MOVE -1 85 true', `Lune, Soleil à 0,5° : suivi (seuil −1°), inclinaison 85°, production > 0 (${m.low})`);
    chk(m.grazing === 'MOVE false', `Lune, Soleil à −0,5° : pas de STOW NIGHT (${m.grazing})`);
    chk(m.night === 'STOW NIGHT true', `Lune, Soleil à −1,3° : STOW NIGHT (${m.night})`);
    chk(m.decor === 'moon,false,false,true,false,0.9,Jour lunaire' && m.light, `décor lunaire : sol gris, ciel noir étoilé, sans nuages (${m.decor})`);
    chk(m.earth === 'earth,true,true,1' && m.sim === 'earth', `retour Terre : désert, nuages, seuil 1° (${m.earth})`);
  }

  if (await evaluate(`typeof gate !== 'undefined'`)) {
    console.log('Porte de validation (Manuel / Semi-auto / Full auto)');
    const g = await evaluate(`(() => { const r = {}; P.autoTime = false; P.tracking = true; P.wind = 1; setDecisionMode('local'); setDataSource('simulation'); applyWeather('clear'); resetForTest();
      let T = 1e6; gate.now = () => T; gate.log = []; gate.queue = []; gate.command = null; gate.lastCardAt = -Infinity;
      const step = () => { updateSunAndSky(); updateStation(); renderDecisionInfo(); };
      const acts = () => sim.decisions.map(d => d.action + '/' + d.source).join(',');
      const last = () => gate.log[0] ? gate.log[0].by + ' ' + gate.log[0].action : '';
      // Manuel : la proposition attend, la station reste immobile (HOLD)
      P.timeOfDay = 12; step(); const tilt0 = sim.panels[0].tiltDeg;
      P.timeOfDay = 10; updateSunAndSky(); setAutonomy('manual'); step();
      r.mQueue = gate.queue.map(c => c.action).join(',') + ' ' + !!gate.queue[0]?.reason; r.mHold = acts(); r.mStill = sim.panels[0].tiltDeg === tilt0;
      r.card = !!document.querySelector('#gate-queue [data-approve]') && $('gate-queue').textContent.includes('Suivi solaire 2 axes');
      document.querySelector('#gate-queue [data-approve]').click(); step();
      r.mApproved = acts() + ' ' + last() + ' ' + (Math.abs(sim.panels[0].tiltDeg - (90 - sim.sun.elevDeg)) < 1e-6);
      // Manuel : refus
      T += 4000; P.timeOfDay = 14; step(); const t1 = sim.panels[0].tiltDeg;
      r.refuseQueue = gate.queue.length; document.querySelector('#gate-queue [data-refuse]').click(); step();
      r.refused = last() + ' ' + (sim.panels[0].tiltDeg === t1) + ' ' + gate.queue.length;
      // Manuel : sans réponse en 30 s, MOVE → HOLD
      T += 4000; P.timeOfDay = 15; step(); r.pending = gate.queue.length; T += 31000; step();
      r.expired = last() + ' ' + (sim.panels[0].tiltDeg === t1) + ' ' + (gate.queue[0]?.createdAt === T);   // reproposée aussitôt (nouveau cycle)
      // Manuel : sans réponse en 30 s, un STOW est appliqué
      T += 4000; P.wind = 3; step(); r.stowCard = gate.queue.map(c => c.action + ':' + c.flags.join('|')).join(',');
      T += 31000; step(); r.stowAuto = acts() + ' ' + last() + ' ' + sim.panels[0].tiltDeg; P.wind = 1;
      // Semi-auto : décision sans risque appliquée directement, décision à risque en file
      setAutonomy('semi'); T += 4000; P.timeOfDay = 12; step(); step();
      r.semiDirect = acts() + ' ' + (gate.log.find(e => e.by === 'IA (Semi-auto)') ? 'IA' : '?');
      T += 4000; P.wind = 3; step(); r.semiRisk = gate.queue.map(c => c.action + ':' + c.flags.join('|')).join(',') + ' ' + acts();
      gate.approve(gate.queue[0].id); step(); r.semiApproved = acts() + ' ' + last(); P.wind = 1;
      // Semi-auto : rotation > 45° (depuis la position à plat) et batterie < 20 %
      T += 4000; P.timeOfDay = 7.5; step(); r.rotation = (gate.queue.at(-1)?.flags || []).join('|');
      gate.queue.forEach(c => gate.refuse(c.id)); gate.command = null;
      T += 4000; sim.battery.socPct = 15; P.timeOfDay = 12; step(); step(); r.battery = (gate.queue.at(-1)?.flags || []).join('|'); sim.battery.socPct = 55;
      // Passage en Full auto : file annulée, tout s'applique directement
      setAutonomy('full'); step(); r.full = gate.queue.length + ' ' + acts() + ' ' + gate.log.some(e => e.by.startsWith('annulée'));
      T += 4000; P.wind = 3; step(); r.fullStow = acts() + ' ' + last(); P.wind = 1; step();
      // Reprise manuelle, puis retour à l'IA
      setTracking(false); r.takeover = acts() + ' ' + gate.log[0].reason + ' ' + $('b-takeover').textContent;
      setTracking(true); r.back = gate.log[0].reason + ' ' + acts();
      // Journal : heure, mode, action, drapeaux, validé par
      const e = gate.log.find(x => x.by === 'humain (approuvée)');
      r.logEntry = !!(e && e.at instanceof Date && e.mode && e.action && Array.isArray(e.flags)) + ' ' + $('gate-log').textContent.includes('validé par');
      gate.now = () => performance.now(); gate.lastCardAt = -Infinity; resetForTest(); step();
      return r; })()`);
    const chk = (cond, msg) => cond ? ok(msg) : fail(msg);
    chk(g.mQueue === 'MOVE true' && g.mHold === 'HOLD/gate,HOLD/gate,HOLD/gate,HOLD/gate' && g.mStill && g.card,
      `Manuel : MOVE en file avec son reason, station immobile (${g.mHold})`);
    chk(g.mApproved === 'MOVE/fallback,MOVE/fallback,MOVE/fallback,MOVE/fallback humain (approuvée) MOVE true', `Approuver → appliqué, journalisé (${g.mApproved})`);
    chk(g.refuseQueue === 1 && g.refused === 'humain (refusée) MOVE true 0', `Refuser → rien n'est appliqué (${g.refused})`);
    chk(g.pending === 1 && g.expired === 'expirée (30 s) : MOVE → HOLD HOLD true true', `30 s sans réponse : MOVE → HOLD (${g.expired})`);
    chk(g.stowCard === 'STOW:HIGH_WIND|STOW' && g.stowAuto.startsWith('STOW/fallback,STOW/fallback,STOW/fallback,STOW/fallback auto (30 s') && g.stowAuto.endsWith(' 0'),
      `30 s sans réponse : STOW appliqué (${g.stowAuto})`);
    chk(g.semiDirect === 'MOVE/fallback,MOVE/fallback,MOVE/fallback,MOVE/fallback IA', 'Semi-auto : décision sans risque appliquée directement (validée par IA)');
    chk(g.semiRisk.startsWith('STOW:HIGH_WIND|STOW') && g.semiRisk.endsWith('HOLD/gate,HOLD/gate,HOLD/gate,HOLD/gate'), `Semi-auto : STOW / vent fort en file (${g.semiRisk})`);
    chk(g.semiApproved === 'STOW/fallback,STOW/fallback,STOW/fallback,STOW/fallback humain (approuvée) STOW', 'Semi-auto : STOW approuvé par un humain');
    chk(g.rotation.includes('ROTATION_45'), `Semi-auto : rotation > 45° → validation (${g.rotation})`);
    chk(g.battery.includes('LOW_BATTERY'), `Semi-auto : batterie < 20 % → validation (${g.battery})`);
    chk(g.full === '0 MOVE/fallback,MOVE/fallback,MOVE/fallback,MOVE/fallback true', `Full auto : file annulée, application directe (${g.full})`);
    chk(g.fullStow === 'STOW/fallback,STOW/fallback,STOW/fallback,STOW/fallback IA (Full auto) STOW', `Full auto : STOW direct, validé par IA (${g.fullStow})`);
    chk(g.takeover.startsWith('HOLD/override') && g.takeover.includes('Reprise manuelle') && g.takeover.endsWith('Rendre la main à l’IA') && g.back.startsWith('Pilotage rendu'),
      'reprise manuelle puis retour à l’IA, journalisés');
    chk(g.logEntry === 'true true', 'journal : heure, mode, action, drapeaux, validé par');
  }

  if (await evaluate(`typeof weatherFx !== 'undefined'`)) {
    console.log('Scénarios météo');
    const w = await evaluate(`(() => { const r = {}; P.autoTime = false; P.tracking = true; P.wind = 1; setDecisionMode('local'); setAutonomy('full'); setDataSource('simulation'); applyWeather('clear');
      const step = () => { updateSunAndSky(); updateStation(); };
      const advance = secs => { for (let t = 0; t < secs; t += 0.25) { weatherFx.update(0.25, {}); step(); applyScenarioAccumulation(0.25); } step(); sampleSensors(); renderSensorUI(); };
      const acts = () => [...new Set(sim.decisions.map(d => d.action))].join('|');
      const dust = () => panels.reduce((a, p) => a + p.dust, 0) / 4, snow = () => panels.reduce((a, p) => a + p.snow, 0) / 4;
      const run = (id, secs, setup) => { resetForTest(); P.timeOfDay = 12; setup && setup(); weatherFx.set(id, { instant: true }); advance(secs);
        const d = sim.decisions[0];
        return { acts: acts(), tilt: Math.round(sim.panels[0].tiltDeg), flags: d.riskFlags.join('|'), reason: d.reason, kw: sim.totalKW,
          wind: sim.env.windMs, ghi: sim.env.ghi, dhiShare: sim.env.ghi > 0 ? sim.env.dhi / sim.env.ghi : 0, amb: sim.env.ambientC, dust: dust(), snow: snow() }; };
      resetForTest(); P.timeOfDay = 12; step(); step(); const base = { kw: sim.totalKW, ghi: sim.env.ghi, wind: sim.env.windMs };
      r.base = base;
      r.sand = run('sand', 8); r.sandSensor = sensorById('anemo').value + ' ' + sensorById('p0.dust').value;
      r.rain = run('rain', 6, () => panels.forEach(p => { p.dust = 60; }));
      r.hail = run('hail', 3); r.flash = !!weatherFx.flash;
      r.snow = run('snow', 20);
      r.heat = run('heat', 3); r.heatTemp = Math.max(...sim.panels.map(p => p.cellC));
      r.fog = run('fog', 3);
      r.solar = run('solar', 3);
      renderScenario(); renderDataInfo();
      r.banner = $('scenario-banner').style.display + ' ' + $('scenario-banner').textContent.includes('Scénario simulé') + ' ' + $('s-data').textContent;
      // Retour au calme progressif, puis bandeau masqué
      resetForTest(); P.timeOfDay = 12; weatherFx.set('sand', { instant: true }); advance(1);
      weatherFx.set('normal'); advance(1); r.fadeWind = sim.env.windMs; advance(5); r.calmWind = sim.env.windMs;
      renderScenario(); renderDataInfo(); r.bannerOff = $('scenario-banner').style.display + ' ' + $('s-data').textContent;
      // Montée progressive (rampe de 4 s)
      resetForTest(); P.timeOfDay = 12; weatherFx.set('sand'); advance(1); r.ramp1 = sim.env.windMs; advance(4); r.ramp5 = sim.env.windMs;
      // Priorité sur les données live
      resetForTest(); setDataSource('live'); DATA_SOURCES.live.ingest(T.payload()); step(); r.liveWind = sim.env.windMs;
      weatherFx.set('sand', { instant: true }); advance(1); renderScenario();
      r.overLive = sim.env.windMs + ' ' + $('scenario-banner').textContent.includes('données live') + ' ' + acts();
      setDataSource('simulation'); resetForTest();
      // Porte Semi-auto : la mise en sécurité passe par la file
      P.timeOfDay = 12; step(); setAutonomy('semi'); weatherFx.set('hail', { instant: true }); gate.lastCardAt = -Infinity; advance(1);
      r.semi = gate.queue.map(c => c.action + ':' + c.flags.join('|')).join(',') + ' ' + acts();
      gate.queue.forEach(c => gate.refuse(c.id)); setAutonomy('full'); resetForTest(); step();
      // Démo automatique (~60 s) en temps simulé
      const seen = [], dustAt = {}; startDemo();
      for (let t = 0; t < 62; t += 0.5) {
        weatherFx.update(0.5, {}); step(); applyScenarioAccumulation(0.5);
        const id = weatherFx.demo ? weatherFx.id : 'fin'; if (seen[seen.length - 1] !== id) seen.push(id);
        if (Math.abs(t - 32) < 0.1) dustAt.beforeDiag = dust();
        if (Math.abs(t - 56) < 0.1) dustAt.afterRain = dust();
        if (Math.abs(t - 16) < 0.1) dustAt.sandActs = acts();
      }
      r.demo = seen.join('>'); r.demoDust = dustAt; r.diag = (gate.log.find(e => e.by === 'diagnostic') || {}).reason || '';
      r.demoEnd = (weatherFx.demo === null) + ' ' + P.autoTime;
      resetForTest(); P.autoTime = false; step();
      return r; })()`);
    const chk = (cond, msg) => cond ? ok(msg) : fail(msg);
    const b = w.base;
    chk(w.sand.wind > 15.9 && w.sand.ghi < 0.4 * b.ghi && w.sand.dust > 40 && w.sand.acts === 'STOW' && w.sand.tilt === 0 && w.sand.flags.includes('HIGH_WIND') && w.sand.reason.includes('tempête de sable'),
      `sable : vent ${w.sand.wind.toFixed(0)} m/s, irradiance ÷${(b.ghi / w.sand.ghi).toFixed(1)}, poussière ${w.sand.dust.toFixed(0)} % → STOW à plat (« ${w.sand.reason} »)`);
    chk(parseFloat(w.sandSensor) > 11 && parseFloat(w.sandSensor.split(' ')[1]) > 30, `sable : capteurs anémomètre et poussière (${w.sandSensor})`);
    chk(w.rain.dust < 30 && w.rain.ghi < 0.5 * b.ghi && w.rain.acts === 'MOVE' && w.rain.reason.startsWith('Pluie'),
      `pluie : poussière 60 → ${w.rain.dust.toFixed(0)} % (nettoyage), suivi adapté (« ${w.rain.reason} »)`);
    chk(w.hail.flags.includes('HAIL') && w.hail.acts === 'STOW' && w.hail.tilt === 85 && w.hail.reason.startsWith('Grêle') && w.hail.wind > 8 && w.flash,
      `grêle : HAIL → STOW incliné au maximum (${w.hail.tilt}°) (« ${w.hail.reason} »)`);
    chk(w.snow.snow > 50 && w.snow.acts === 'MOVE' && w.snow.tilt === 60 && w.snow.kw < 0.1 * b.kw && w.snow.reason.startsWith('Neige'),
      `neige : couverture ${w.snow.snow.toFixed(0)} %, production ${w.snow.kw.toFixed(2)} kW, inclinaison forte ${w.snow.tilt}° (« ${w.snow.reason} »)`);
    chk(Math.abs(w.heat.amb - 47) < 0.01 && w.heatTemp > 65 && w.heat.flags.includes('HIGH_TEMP') && w.heat.kw < b.kw && w.heat.reason.includes('perte thermique'),
      `canicule : cellules ${w.heatTemp.toFixed(0)} °C, ${w.heat.kw.toFixed(1)} < ${b.kw.toFixed(1)} kW (« ${w.heat.reason} »)`);
    chk(w.fog.dhiShare > 0.8 && w.fog.acts === 'MOVE' && w.fog.tilt <= 12 && w.fog.reason.includes('diffus'),
      `brouillard : ${Math.round(w.fog.dhiShare * 100)} % diffus → presque à plat (« ${w.fog.reason} »)`);
    chk(w.solar.flags.includes('SPACE_WEATHER') && w.solar.acts === 'STOW' && w.solar.tilt === 0, `tempête solaire : SPACE_WEATHER → STOW (« ${w.solar.reason} »)`);
    chk(w.banner === 'block true Scénario', `bandeau « Scénario simulé » et badge (${w.banner})`);
    chk(w.fadeWind > b.wind + 1 && Math.abs(w.calmWind - b.wind) < 1e-9 && w.bannerOff === 'none Simu', `retour au calme progressif (${w.fadeWind.toFixed(1)} → ${w.calmWind} m/s), bandeau masqué`);
    chk(w.ramp1 > b.wind + 0.5 && w.ramp1 < 15 && w.ramp5 > 15.9, `montée progressive (${w.ramp1.toFixed(1)} m/s à 1 s, ${w.ramp5.toFixed(1)} à 5 s)`);
    chk(w.liveWind === 2 && w.overLive.startsWith('16 true STOW'), `priorité sur le live (live 2 m/s → ${w.overLive})`);
    chk(w.semi.startsWith('STOW:HAIL|STOW') && w.semi.endsWith('HOLD'), `Semi-auto : la grêle passe par la file (${w.semi})`);
    chk(w.demo === 'normal>sand>normal>rain>normal>fin' && w.demoEnd === 'true false', `démo automatique : ${w.demo}`);
    chk(w.demoDust.sandActs === 'STOW' && w.demoDust.beforeDiag > 30 && w.diag.includes('nettoyage recommandé') && w.demoDust.afterRain < w.demoDust.beforeDiag - 20,
      `démo : STOW pendant le sable, diagnostic (« ${w.diag} »), pluie ${w.demoDust.beforeDiag.toFixed(0)} → ${w.demoDust.afterRain.toFixed(0)} %`);
  }

  console.log('Production (baseline)');
  const results = await evaluate(SCENARIOS);
  if (args.update || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, JSON.stringify(results, null, 1));
    ok(`baseline écrite (${results.length} scénarios)`);
  } else {
    const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
    let diffs = 0;
    for (const b of base) {
      const r = results.find(x => x.key === b.key);
      if (!r) { fail('scénario manquant ' + b.key); diffs++; continue; }
      const bad = b.panelsKW.some((v, i) => Math.abs(v - r.panelsKW[i]) > TOL);
      if (bad) { diffs++; if (diffs <= 8) fail(`${b.key}: attendu ${b.totalKW.toFixed(3)} kW, obtenu ${r.totalKW.toFixed(3)} kW`); }
    }
    diffs ? fail(`${diffs} scénario(s) différent(s) de la baseline`) : ok(`${base.length} scénarios identiques à la baseline`);
  }
  if (args.table) for (const r of results) console.log('   ', r.key.padEnd(22), r.totalKW.toFixed(2).padStart(6), 'kW');

  if (args.shot) {
    if (args.eval) { const r = await evaluate(args.eval); if (r !== undefined) console.log('  eval →', JSON.stringify(r)); }
    await sleep(800);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(args.shot, Buffer.from(shot.result.data, 'base64'));
    ok('capture: ' + args.shot);
  }

  console.log('Erreurs JS');
  errors.length ? errors.forEach(e => fail(e)) : ok('aucune erreur console');
} catch (e) { fail(e.message); }
finally {
  // Fermeture ordonnée : un process.exit() pendant la fermeture du WebSocket fait planter libuv sous Windows.
  if (ws && ws.readyState === WebSocket.OPEN) await new Promise(r => { ws.onclose = r; ws.close(); setTimeout(r, 1000); });
  chrome.kill(); mock.closeAllConnections?.(); mock.close();
}
console.log(failed ? '\nÉCHEC' : '\nOK');
process.exitCode = failed ? 1 : 0;
setTimeout(() => process.exit(), 300).unref();
