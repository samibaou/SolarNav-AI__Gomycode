// SolarNav — scénarios météo pour la démo (simulés, jamais confondus avec le réel : bandeau « Scénario simulé »).
// Un scénario modifie progressivement (rampe de RAMP_S secondes) l'EnvironmentFrame de la source active, en priorité
// sur les données live/replay : les capteurs virtuels, la physique et la décision en voient les effets.
//   fx.set(id)                 → démarre un scénario ('normal' = aucun)
//   fx.applyToFrame(frame)     → frame modifié (vent, irradiance directe/diffuse, température, drapeaux)
//   fx.rates()                 → { dustPerS, snowPerS } : effets cumulés sur les panneaux (appliqués par la page)
//   fx.update(dt)              → avance la rampe, la démo automatique et les effets visuels (particules, éclairs, brouillard)
//   fx.startDemo(hooks)        → démo ~60 s : normal → tempête de sable → calme → diagnostic de nettoyage → pluie

const RAMP_S = 4;
const SCENARIOS = {
  normal: { label: 'Normal' },
  sand: { label: 'Tempête de sable', condition: 'sand', wind: 16, ghi: 0.35, direct: 0.12, dustPerS: 9,
    particles: { color: 0xc9955a, size: 0.35, vy: -1.5, vx: 22, opacity: 0.75 }, fog: { color: 0xc08a58, density: 0.035 }, sky: 'overcast' },
  rain: { label: 'Pluie', condition: 'rain', wind: 6, ghi: 0.45, direct: 0.25, ambientDelta: -6, dustPerS: -7,
    particles: { color: 0xa9c3e0, size: 0.16, vy: -30, vx: 3, opacity: 0.7 }, fog: { color: 0x8d99a6, density: 0.012 }, sky: 'overcast' },
  hail: { label: 'Orage + grêle', condition: 'hail', hail: true, wind: 9, ghi: 0.25, direct: 0.1, ambientDelta: -9,
    particles: { color: 0xf0f6ff, size: 0.42, vy: -24, vx: 4, opacity: 0.95 }, fog: { color: 0x5d6673, density: 0.015 }, sky: 'overcast', lightning: true },
  snow: { label: 'Neige', condition: 'snow', wind: 3, ghi: 0.25, direct: 0.08, ambientTo: -3, snowPerS: 12,
    particles: { color: 0xffffff, size: 0.34, vy: -2.6, vx: 1.2, opacity: 0.9, sway: 1 }, fog: { color: 0xc9d1da, density: 0.014 }, sky: 'overcast' },
  heat: { label: 'Canicule', condition: 'heat', wind: 1, ambientTo: 47, fog: { color: 0xe6c79a, density: 0.004 } },
  fog: { label: 'Brouillard', condition: 'fog', wind: 0.5, ghi: 0.3, direct: 0.03, ambientDelta: -4,
    fog: { color: 0xc3c9cf, density: 0.06 }, sky: 'overcast' },
  solar: { label: 'Tempête solaire (Lune)', condition: 'solar', spaceWeather: true },
};
// Démo automatique : [instant (s), scénario ou étape, message du bandeau]
const DEMO_TIMELINE = [
  [0, 'normal', 'Démo : situation normale, suivi solaire'],
  [8, 'sand', 'Démo : tempête de sable — vent fort, irradiance en chute, poussière en hausse'],
  [24, 'normal', 'Démo : retour au calme'],
  [33, 'diagnostic', 'Démo : diagnostic de nettoyage'],
  [41, 'rain', 'Démo : pluie — nettoyage naturel des panneaux'],
  [57, 'normal', 'Démo : fin'],
];
const DEMO_DURATION_S = 60;
const SNOW_SHED_MIN_TILT = 50, SNOW_SHED_PER_S = 5, SNOW_MELT_PER_S = 2;

function createWeatherFx({ scene, THREE: T }) {
  // ---------- Effets visuels (légers : un seul Points, ~3500 sommets mis à jour par image) ----------
  const N = 3500, BOX = { x: 45, y: 36, z: 45 };
  const pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 2 * BOX.x; pos[i * 3 + 1] = Math.random() * BOX.y; pos[i * 3 + 2] = (Math.random() - 0.5) * 2 * BOX.z;
    seed[i] = Math.random() * Math.PI * 2;
  }
  const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3));
  const dot = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d'), r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.5, 'rgba(255,255,255,.6)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 32, 32); return new T.CanvasTexture(c);
  })();
  const mat = new T.PointsMaterial({ size: 0.3, map: dot, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true });
  const points = new T.Points(geo, mat); points.visible = false; points.frustumCulled = false; scene.add(points);
  const flash = new T.AmbientLight(0xdde6ff, 0); scene.add(flash);
  const fogColor = new T.Color();

  // Applique un scénario à un frame avec une intensité k (0 = sans effet, 1 = plein effet).
  function applyDef(d, f, k) {
    if (!d || k <= 0) return f;
    const lerp = (x, y) => x + (y - x) * k, out = { ...f };
    if (d.wind !== undefined) out.windMs = lerp(f.windMs, d.wind);
    if (d.ambientTo !== undefined) out.ambientC = lerp(f.ambientC, d.ambientTo);
    if (d.ambientDelta !== undefined) out.ambientC = f.ambientC + d.ambientDelta * k;
    if (d.ghi !== undefined) {
      const sinEl = Math.max(0, Math.sin(f.sunElevDeg * Math.PI / 180));
      out.ghi = f.ghi * lerp(1, d.ghi);
      out.dni = f.dni * lerp(1, d.direct);
      out.dhi = Math.max(0, out.ghi - out.dni * sinEl);   // le reste de la lumière arrive diffusée
      out.cloudFactor = f.cloudFactor == null ? null : f.cloudFactor * lerp(1, d.ghi);
    }
    return out;
  }

  return {
    id: 'normal', prev: null, prevK: 0, sinceStart: RAMP_S, flashT: 0, nextFlash: 3,
    demo: null,                        // { t, step, hooks }
    message: null,                     // texte du bandeau pendant la démo
    get active() { return this.id !== 'normal'; },
    get def() { return SCENARIOS[this.id]; },
    ramp() { return Math.min(1, this.sinceStart / RAMP_S); },
    k() { return this.active ? this.ramp() : 0; },
    // L'ancien scénario s'estompe pendant que le nouveau monte (retour au calme progressif).
    fade() { return this.prev ? this.prevK * (1 - this.ramp()) : 0; },
    // Simulé à l'écran : scénario actif ou encore en train de s'estomper.
    get shown() { return this.active || this.fade() > 0; },

    set(id, { instant = false } = {}) {
      if (!SCENARIOS[id]) throw new Error('scénario inconnu : ' + id);
      if (id === this.id) return;
      const k = this.k() || this.fade();
      this.prev = instant || k <= 0 ? null : (this.active ? this.id : this.prev);
      this.prevK = instant ? 0 : k;
      this.id = id; this.sinceStart = instant ? RAMP_S : 0;
    },

    applyToFrame(f) {
      if (!this.shown) return f;
      let out = applyDef(SCENARIOS[this.prev], f, this.fade());
      out = applyDef(this.def, out, this.k());
      const d = this.def, k = this.k();
      return { ...out, dustPct: null, scenario: this.active ? this.id : null,
        condition: this.active ? d.condition : null, hail: !!d.hail && k > 0.5 };
    },

    spaceWeather() {
      return this.active && this.def.spaceWeather && this.k() > 0.5
        ? { level: 'strong', riskFlags: ['SPACE_WEATHER'], recommendedAction: 'STOW', reasons: ['scénario simulé : éruption X, Kp 8'] } : null;
    },
    rates() {
      const d = this.def, k = this.k();
      return { dustPerS: (d.dustPerS || 0) * k, snowPerS: (d.snowPerS || 0) * k };
    },
    visualWeather() {
      const d = this.active && this.k() > 0.3 ? this.def : this.fade() > 0.3 ? SCENARIOS[this.prev] : null;
      return d?.sky || null;
    },

    startDemo(hooks = {}) { this.demo = { t: 0, step: -1, hooks }; this.advanceDemo(0); },
    stopDemo() { if (this.demo) { this.demo.hooks.end?.(); this.demo = null; this.message = null; this.set('normal'); } },
    advanceDemo(dt) {
      const D = this.demo; if (!D) return;
      D.t += dt;
      while (D.step + 1 < DEMO_TIMELINE.length && D.t >= DEMO_TIMELINE[D.step + 1][0]) {
        D.step++;
        const [, what, msg] = DEMO_TIMELINE[D.step];
        this.message = msg;
        if (what === 'diagnostic') D.hooks.diagnostic?.(); else this.set(what);
        D.hooks.step?.(what, msg);
      }
      if (D.t >= DEMO_DURATION_S) this.stopDemo();
    },

    // dt en secondes réelles. Avance la rampe, la démo, puis les effets visuels.
    update(dt, { fog, sunLight } = {}) {
      this.sinceStart += dt;
      if (this.prev && this.ramp() >= 1) this.prev = null;
      this.advanceDemo(dt);
      // Effet visuel dominant : le scénario actif, sinon celui qui s'estompe.
      const cur = this.k() > 0 ? this.def : null, old = this.fade() > 0 ? SCENARIOS[this.prev] : null;
      const d = cur || old || this.def, w = cur ? this.k() : old ? this.fade() : 0;
      // Particules : chute + vent, recyclées dans une boîte autour de la station.
      const p = (cur && cur.particles) || (old && old.particles) || null;
      const pw = cur && cur.particles ? this.k() : old && old.particles ? this.fade() : 0;
      points.visible = !!p && pw > 0.01;
      if (points.visible) {
        mat.color.setHex(p.color); mat.size = p.size; mat.opacity = p.opacity * pw;
        for (let i = 0; i < N; i++) {
          const j = i * 3;
          pos[j] += (p.vx + (p.sway ? Math.sin(this.sinceStart * 1.3 + seed[i]) * p.sway : 0)) * dt;
          pos[j + 1] += p.vy * dt * (0.8 + 0.4 * ((seed[i] * 7) % 1));
          pos[j + 2] += (p.sway ? Math.cos(this.sinceStart + seed[i]) * p.sway * 0.5 : 0) * dt;
          if (pos[j + 1] < 0) { pos[j + 1] += BOX.y; pos[j] = (Math.random() - 0.5) * 2 * BOX.x; }
          if (pos[j] > BOX.x) pos[j] -= 2 * BOX.x; else if (pos[j] < -BOX.x) pos[j] += 2 * BOX.x;
        }
        geo.attributes.position.needsUpdate = true;
      }
      // Brouillard / brume : mélangé à la brume du décor (appelé après scenery.update).
      if (fog && d.fog && w > 0) {
        fog.color.lerp(fogColor.setHex(d.fog.color), w);
        fog.density += (d.fog.density - fog.density) * w;
      }
      if (sunLight && d.ghi !== undefined && w > 0) sunLight.intensity *= 1 - (1 - d.ghi) * w;
      // Éclairs : flash bref toutes les 3 à 7 s.
      if (cur && cur.lightning && this.k() > 0.5) {
        this.nextFlash -= dt;
        if (this.nextFlash <= 0) { this.flashT = 0.18; this.nextFlash = 3 + Math.random() * 4; }
      }
      this.flashT = Math.max(0, this.flashT - dt);
      flash.intensity = this.flashT > 0 ? 2.2 * (0.5 + 0.5 * Math.sin(this.flashT * 90)) : 0;
    },
    labels() { return Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.label])); },
    points, flash,
  };
}
