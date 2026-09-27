// SolarNav — décor réaliste (visuel uniquement, n'influence pas la physique).
// Ciel physique (Preetham, THREE.Sky), terrain désertique procédural (dunes, Atlas à l'horizon, piste),
// équipements de station (clôture, poste onduleur, local technique, mât météo), champ PV décoratif,
// nuages volumétriques en sprites éclairés selon l'heure, ombres des nuages au sol, halo solaire.
//
// createScenery({scene, renderer, cellTex}) → { sky, envSky, makeCloud(), update(ctx), setSite(site), site() }
// setSite('moon') : sol lunaire gris à cratères (construit au premier appel), ciel noir, ni brume ni nuages.
// update(ctx) : ctx = { sunDir (Vector3 normalisé), sunLight, hemi, clouds (Group), weather ('clear'|'partly'|'overcast'), windMs, dt }

function createScenery({ scene, renderer, cellTex }) {
  const T = THREE;

  // ---------- Bruit ----------
  function hash(x, y) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, oct = 5) {
    let s = 0, amp = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += amp * noise(x * f, y * f); n += amp; amp *= 0.5; f *= 2.03; }
    return s / n;
  }
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  function canvasTex(size, draw, repeat) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new T.CanvasTexture(c);
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(repeat, repeat); }
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  }
  function noiseTex(size, fn) {
    return (ctx, s) => {
      const img = ctx.createImageData(s, s);
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const [r, g, b, a] = fn(x, y, s), k = (y * s + x) * 4;
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = a ?? 255;
      }
      ctx.putImageData(img, 0, 0);
    };
  }

  // ---------- Ombres des nuages (injectées dans les matériaux du sol) ----------
  const MAX_CLOUD_SHADOWS = 16;
  const cloudUniforms = { uCloud: { value: Array.from({ length: MAX_CLOUD_SHADOWS }, () => new T.Vector4(0, 0, 1, 0)) } };
  function addCloudShadows(mat) {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uCloud = cloudUniforms.uCloud;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCloudXZ;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCloudXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vCloudXZ;\nuniform vec4 uCloud[${MAX_CLOUD_SHADOWS}];`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          float cloudSh = 0.0;
          for (int i = 0; i < ${MAX_CLOUD_SHADOWS}; i++) {
            vec4 c = uCloud[i];
            cloudSh = max(cloudSh, c.w * (1.0 - smoothstep(c.z * 0.35, c.z, distance(vCloudXZ, c.xy))));
          }
          reflectedLight.directDiffuse *= 1.0 - cloudSh;
          reflectedLight.directSpecular *= 1.0 - cloudSh;`);
    };
    return mat;
  }

  // ---------- Ciel physique ----------
  let sky = null, envSky = null;
  if (T.Sky) {
    sky = new T.Sky();
    // Gain de sortie : le modèle de Preetham est prévu pour une exposition ~0.5 ; la scène est réglée à 1.25.
    const patch = m => {
      m.uniforms.skyGain = { value: 0.42 };
      m.fragmentShader = 'uniform float skyGain;\n' + m.fragmentShader.replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( retColor * skyGain, 1.0 );');
    };
    patch(sky.material);
    sky.scale.setScalar(800); sky.frustumCulled = false; sky.renderOrder = -1;
    scene.add(sky);
    envSky = new T.Mesh(sky.geometry, sky.material);
    envSky.scale.setScalar(20);
  }
  const SKY_BY_WEATHER = {
    clear: { turbidity: 4, rayleigh: 1.2, mie: 0.005, g: 0.8, light: 1, overcast: 0 },
    partly: { turbidity: 8, rayleigh: 1.4, mie: 0.008, g: 0.8, light: 0.85, overcast: 0.12 },
    overcast: { turbidity: 18, rayleigh: 0.6, mie: 0.02, g: 0.7, light: 0.45, overcast: 0.72 },
  };

  // ---------- Terrain ----------
  // Zone plate : station + champs PV (|x| < 80, |z| < 100) ; piste d'accès vers l'est ; Atlas au-delà de 230 m.
  function height(x, z) {
    const d = Math.max(Math.abs(x) / 80, Math.abs(z) / 100);
    const open = smooth(1.0, 1.6, d);
    const road = x > 0 ? smooth(4, 12, Math.abs(z + Math.sin(x * 0.01) * 6 * smooth(80, 200, x))) : 1;
    let h = (fbm(x * 0.011 + 3, z * 0.011 - 5, 5) - 0.45) * 16 * open * road;
    const dune = Math.pow(Math.abs(Math.sin(x * 0.021 + z * 0.008 + fbm(x * 0.005, z * 0.005, 2) * 5)), 2.5);
    h += dune * 3.5 * open * road;
    const r = Math.hypot(x, z), m = smooth(230, 340, r);
    if (m > 0) h += m * (Math.pow(fbm(x * 0.0055 + 11, z * 0.0055 - 7, 6), 1.6) * 150 + 10);
    return h;
  }
  const TER = 1000, SEG = 256;
  const tGeo = new T.PlaneGeometry(TER, TER, SEG, SEG); tGeo.rotateX(-Math.PI / 2);
  const tp = tGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) tp.setY(i, height(tp.getX(i), tp.getZ(i)));
  tGeo.computeVertexNormals();
  const tn = tGeo.attributes.normal, colors = new Float32Array(tp.count * 3);
  const sand = new T.Color(0xa86e44), sandLight = new T.Color(0xc08a5c), rock = new T.Color(0x6b4430), stone = new T.Color(0x7e6555), roadC = new T.Color(0x9c8672);
  const cc = new T.Color();
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i), y = tp.getY(i), z = tp.getZ(i), slope = 1 - tn.getY(i);
    cc.copy(sand).lerp(sandLight, fbm(x * 0.03, z * 0.03, 3));
    cc.lerp(rock, smooth(0.12, 0.45, slope));
    cc.lerp(stone, smooth(25, 110, y) * 0.7);
    if (x > 20) cc.lerp(roadC, 1 - smooth(3, 5.5, Math.abs(z + Math.sin(x * 0.01) * 6 * smooth(80, 200, x))));
    colors.set([cc.r, cc.g, cc.b], i * 3);
  }
  tGeo.setAttribute('color', new T.BufferAttribute(colors, 3));
  const grainTex = canvasTex(256, noiseTex(256, (x, y) => { const v = 200 + 55 * (0.6 * hash(x, y) + 0.4 * noise(x / 6, y / 6)); return [v, v, v]; }), 180);
  const terrain = new T.Mesh(tGeo, addCloudShadows(new T.MeshStandardMaterial({ vertexColors: true, map: grainTex, bumpMap: grainTex, bumpScale: 0.015, roughness: 0.96, metalness: 0 })));
  terrain.material.envMapIntensity = 0.3;
  terrain.receiveShadow = true;
  scene.add(terrain);

  // ---------- Station ----------
  const station = new T.Group(); scene.add(station);
  const std = (color, rough = 0.6, metal = 0.1, extra = {}) => new T.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
  const shadowed = m => { m.castShadow = true; m.receiveShadow = true; return m; };
  const box = (w, h, d, mat, x, y, z) => { const m = shadowed(new T.Mesh(new T.BoxGeometry(w, h, d), mat)); m.position.set(x, y, z); station.add(m); return m; };

  // Plateforme en gravier
  const gravelTex = canvasTex(256, noiseTex(256, (x, y) => {
    const g = hash(x * 3, y * 7), v = 150 + 70 * g + 20 * noise(x / 3, y / 3); return [v, v * 0.95, v * 0.88];
  }), 14);
  const pad = new T.Mesh(new T.PlaneGeometry(56, 44), addCloudShadows(std(0x9a8f80, 1, 0, { map: gravelTex })));
  pad.rotation.x = -Math.PI / 2; pad.position.y = 0.02; pad.receiveShadow = true; station.add(pad);

  // Clôture grillagée (portail côté piste, est)
  const meshTex = canvasTex(64, (ctx, s) => {
    ctx.clearRect(0, 0, s, s); ctx.strokeStyle = 'rgba(200,205,210,1)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(s, s); ctx.moveTo(s, 0); ctx.lineTo(0, s); ctx.stroke();
  });
  meshTex.wrapS = meshTex.wrapT = T.RepeatWrapping;
  const fenceMat = std(0xb8bec4, 0.5, 0.7, { map: meshTex, alphaTest: 0.45, transparent: false, side: T.DoubleSide });
  const postMat = std(0x8d949b, 0.4, 0.8);
  const FX = 28, FZ = 22, FH = 2.2;
  const sides = [[[-FX, -FZ], [FX, -FZ]], [[FX, -FZ], [FX, -4]], [[FX, 4], [FX, FZ]], [[FX, FZ], [-FX, FZ]], [[-FX, FZ], [-FX, -FZ]]];
  const posts = [];
  sides.forEach(([[x0, z0], [x1, z1]]) => {
    const len = Math.hypot(x1 - x0, z1 - z0), tex = meshTex.clone(); tex.needsUpdate = true; tex.repeat.set(len / 0.35, FH / 0.35);
    const m = new T.Mesh(new T.PlaneGeometry(len, FH), fenceMat.clone()); m.material.map = tex;
    m.position.set((x0 + x1) / 2, FH / 2 + 0.05, (z0 + z1) / 2); m.rotation.y = -Math.atan2(z1 - z0, x1 - x0); m.castShadow = true; station.add(m);
    const n = Math.ceil(len / 3.5);
    for (let k = 0; k <= n; k++) posts.push([x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n]);
  });
  const postGeo = new T.CylinderGeometry(0.05, 0.05, FH + 0.3, 6);
  const postInst = shadowed(new T.InstancedMesh(postGeo, postMat, posts.length));
  const mtx = new T.Matrix4();
  posts.forEach(([x, z], i) => postInst.setMatrixAt(i, mtx.makeTranslation(x, (FH + 0.3) / 2, z)));
  station.add(postInst);

  // Poste onduleur + transformateur
  const ventTex = canvasTex(128, (ctx, s) => { ctx.fillStyle = '#dfe3e7'; ctx.fillRect(0, 0, s, s); ctx.fillStyle = '#9aa3ab'; for (let y = 8; y < s; y += 8) ctx.fillRect(10, y, s - 20, 3); });
  box(6, 2.6, 2.4, std(0xdfe3e7, 0.55, 0.3, { map: ventTex }), 19, 1.3, -14);
  box(0.15, 2.2, 1.0, std(0x5b6470, 0.5, 0.6), 22.05, 1.2, -14);
  box(2.2, 1.9, 1.8, std(0x7d8a76, 0.55, 0.4), 14.6, 0.95, -14);
  for (let k = -3; k <= 3; k++) box(0.06, 1.5, 1.9, std(0x6c7866, 0.5, 0.5), 14.6 + k * 0.3, 0.9, -12.9);
  box(0.9, 0.5, 0.5, std(0x3a3f45, 0.6, 0.3), 14.6, 2.1, -14);

  // Local technique
  const wall = std(0xe6dcc8, 0.9, 0);
  box(8, 3.2, 5, wall, -19, 1.6, 14);
  box(8.6, 0.25, 5.6, std(0xcfc6b6, 0.9, 0), -19, 3.3, 14);
  box(1.1, 2.1, 0.08, std(0x4d5660, 0.5, 0.5), -17, 1.05, 11.46);
  const glass = std(0x2b3f55, 0.08, 0.9);
  box(1.6, 1.0, 0.08, glass, -21, 1.9, 11.46); box(1.6, 1.0, 0.08, glass, -14.96, 1.9, 13);
  box(1.0, 0.7, 0.6, std(0xf1f1ee, 0.6, 0.2), -22, 3.8, 15);
  const ant = box(0.04, 2.2, 0.04, postMat, -16, 4.5, 15.8);

  // Mât météo : pyranomètre + anémomètre à coupelles (tourne avec le vent réel de la source)
  const mast = new T.Group(); mast.position.set(22, 0, 14); station.add(mast);
  const mastMat = std(0xc9ced3, 0.4, 0.8);
  const pole = shadowed(new T.Mesh(new T.CylinderGeometry(0.06, 0.08, 6, 8), mastMat)); pole.position.y = 3; mast.add(pole);
  const arm = shadowed(new T.Mesh(new T.BoxGeometry(1.6, 0.05, 0.05), mastMat)); arm.position.set(0, 5.4, 0); mast.add(arm);
  const pyr = shadowed(new T.Mesh(new T.SphereGeometry(0.12, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(0xf4f6f8, 0.1, 0.1))); pyr.position.set(0.75, 5.46, 0); mast.add(pyr);
  const anemo = new T.Group(); anemo.position.set(0, 6.15, 0); mast.add(anemo);
  const spindle = new T.Mesh(new T.CylinderGeometry(0.02, 0.02, 0.3, 6), mastMat); spindle.position.y = -0.15; anemo.add(spindle);
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI * 2 / 3, g = new T.Group(); g.rotation.y = a; anemo.add(g);
    const rod = new T.Mesh(new T.BoxGeometry(0.35, 0.015, 0.015), mastMat); rod.position.x = 0.175; g.add(rod);
    const cup = new T.Mesh(new T.SphereGeometry(0.06, 10, 6, 0, Math.PI), std(0x2d333a, 0.5, 0.3)); cup.position.set(0.35, 0, 0); cup.rotation.y = Math.PI / 2; g.add(cup);
  }

  // Chemins de câbles vers le poste onduleur
  const trayMat = std(0x8f969c, 0.5, 0.7);
  box(0.4, 0.15, 10, trayMat, 11, 0.08, -9); box(9, 0.15, 0.4, trayMat, 6.5, 0.08, -4);

  // ---------- Champ PV décoratif (tables fixes orientées plein sud, hors clôture) ----------
  const tableW = 7.2, tableD = 3.4, TILT = 28 * Math.PI / 180;
  const spots = [];
  for (const side of [1, -1]) for (let zr = 0; zr < 8; zr++) for (let xr = 0; xr < 17; xr++) {
    const x = -62 + xr * 7.8, z = side * (32 + zr * 8);
    if (Math.abs(x) < 4 && side === 1 && zr < 1) continue;
    spots.push([x, z]);
  }
  const decoPvMat = std(0x0c2a4a, 0.22, 0.55, { map: cellTex });
  const decoFrameMat = std(0x9aa1a8, 0.4, 0.8);
  const topGeo = new T.BoxGeometry(tableW, 0.05, tableD), legGeo = new T.BoxGeometry(0.08, 1, 0.08);
  const tops = shadowed(new T.InstancedMesh(topGeo, decoPvMat, spots.length));
  const legs = shadowed(new T.InstancedMesh(legGeo, decoFrameMat, spots.length * 4));
  const q = new T.Quaternion().setFromEuler(new T.Euler(TILT, 0, 0)), one = new T.Vector3(1, 1, 1), p3 = new T.Vector3();
  const lowH = 0.7, highH = lowH + Math.sin(TILT) * tableD;
  spots.forEach(([x, z], i) => {
    p3.set(x, (lowH + highH) / 2 + 0.05, z); tops.setMatrixAt(i, mtx.compose(p3, q, one));
    [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sz], k) => {
      const hgt = sz > 0 ? lowH : highH;   // bord sud bas, bord nord haut
      p3.set(x + sx * (tableW / 2 - 0.4), hgt / 2, z + sz * Math.cos(TILT) * tableD / 2);
      legs.setMatrixAt(i * 4 + k, mtx.compose(p3, new T.Quaternion(), new T.Vector3(1, hgt, 1)));
    });
  });
  station.add(tops, legs);

  // ---------- Nuages ----------
  const puffTextures = [0, 1, 2, 3].map(seed => canvasTex(128, noiseTex(128, (x, y, s) => {
    const dx = (x - s / 2) / (s / 2), dy = (y - s / 2) / (s / 2), r = Math.hypot(dx, dy);
    const n = fbm(x / 18 + seed * 7, y / 18 - seed * 3, 5);
    const a = Math.max(0, 1 - r) ** 1.4 * smooth(0.25, 0.7, n + 0.35 * (1 - r));
    return [255, 255, 255, Math.round(255 * Math.min(1, a * 1.6))];
  })));
  function makeCloud() {
    const grp = new T.Group();
    const w = 40 + Math.random() * 50, h = 8 + Math.random() * 8, d = 25 + Math.random() * 25, puffs = 10 + Math.floor(Math.random() * 8);
    for (let i = 0; i < puffs; i++) {
      const s = new T.Sprite(new T.SpriteMaterial({ map: puffTextures[i % 4], transparent: true, depthWrite: false, fog: true, opacity: 0.9 }));
      const u = Math.random(), sc = (18 + Math.random() * 20) * (1 - 0.35 * Math.abs(u - 0.5));
      s.scale.set(sc * 1.25, sc, 1);
      s.position.set((u - 0.5) * w, Math.random() * h - h * 0.3, (Math.random() - 0.5) * d);
      s.userData.shade = Math.min(1, Math.max(0, (s.position.y + h * 0.3) / h));   // 0 = base, 1 = sommet
      grp.add(s);
    }
    grp.position.set((Math.random() - 0.5) * 560, 75 + Math.random() * 45, (Math.random() - 0.5) * 520);
    grp.userData.speed = 0.6 + Math.random() * 0.8;
    grp.userData.radius = w * 0.45;
    return grp;
  }
  // Voile nuageux (ciel couvert)
  const veilTex = canvasTex(256, noiseTex(256, (x, y) => [255, 255, 255, Math.round(255 * smooth(0.3, 0.75, fbm(x / 40, y / 40, 5)))]), 3);
  const veil = new T.Mesh(new T.PlaneGeometry(1400, 1400), new T.MeshBasicMaterial({ map: veilTex, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide, fog: false }));
  veil.rotation.x = Math.PI / 2; veil.position.y = 140; scene.add(veil);

  // ---------- Halo / reflets d'objectif ----------
  let flareAnchor = null;
  if (T.Lensflare) {
    const glow = canvasTex(256, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,245,1)'); g.addColorStop(0.08, 'rgba(255,245,220,.9)'); g.addColorStop(0.3, 'rgba(255,210,150,.18)'); g.addColorStop(1, 'rgba(255,180,120,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    });
    const ring = canvasTex(128, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.28, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.7, 'rgba(255,255,255,.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    });
    const flare = new T.Lensflare();
    flare.addElement(new T.LensflareElement(glow, 420, 0, new T.Color(1, 0.95, 0.85)));
    flare.addElement(new T.LensflareElement(ring, 70, 0.55, new T.Color(0.6, 0.8, 1)));
    flare.addElement(new T.LensflareElement(ring, 110, 0.75, new T.Color(1, 0.8, 0.6)));
    flare.addElement(new T.LensflareElement(ring, 50, 0.95, new T.Color(0.7, 1, 0.8)));
    flareAnchor = new T.Object3D(); flareAnchor.add(flare); scene.add(flareAnchor);
  }

  // ---------- Site lunaire (pôle Sud) : régolithe gris, cratères, pas d'atmosphère ----------
  let site = 'earth', moonTerrain = null;
  function buildMoonTerrain() {
    const R = (k) => hash(k * 7 + 3, k * 13 + 5);
    const craters = [];
    for (let k = 0; k < 90; k++) {
      const ang = R(k) * Math.PI * 2, dist = 70 + Math.pow(R(k + 500), 0.7) * 430, rad = 4 + Math.pow(R(k + 900), 3) * 45;
      craters.push([Math.cos(ang) * dist, Math.sin(ang) * dist, rad]);
    }
    function mHeight(x, z) {
      const d = Math.max(Math.abs(x) / 60, Math.abs(z) / 60), open = smooth(0.9, 1.5, d);
      let h = (fbm(x * 0.02 + 17, z * 0.02 - 9, 4) - 0.5) * 3 * open;
      for (const [cx, cz, r] of craters) {
        const q = Math.hypot(x - cx, z - cz) / r;
        if (q < 1.6) h += (q < 1 ? (q * q - 1) * 0.28 * r : 0) + 0.09 * r * Math.exp(-((q - 1) ** 2) / 0.04);   // cuvette + rempart
      }
      return h * open + smooth(260, 420, Math.hypot(x, z)) * fbm(x * 0.006, z * 0.006, 5) * 60;
    }
    const g = new T.PlaneGeometry(TER, TER, SEG, SEG); g.rotateX(-Math.PI / 2);
    const gp = g.attributes.position;
    for (let i = 0; i < gp.count; i++) gp.setY(i, mHeight(gp.getX(i), gp.getZ(i)));
    g.computeVertexNormals();
    const col = new Float32Array(gp.count * 3), dark = new T.Color(0x55565a), light = new T.Color(0x8e8f92), c2 = new T.Color();
    for (let i = 0; i < gp.count; i++) {
      c2.copy(dark).lerp(light, fbm(gp.getX(i) * 0.04, gp.getZ(i) * 0.04, 3));
      col.set([c2.r, c2.g, c2.b], i * 3);
    }
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    const m = new T.Mesh(g, new T.MeshStandardMaterial({ vertexColors: true, map: grainTex, bumpMap: grainTex, bumpScale: 0.03, roughness: 1, metalness: 0 }));
    m.material.envMapIntensity = 0.05; m.receiveShadow = true; m.visible = false;
    scene.add(m);
    return m;
  }
  function setSite(s) {
    if (s === site) return;
    site = s;
    if (s === 'moon' && !moonTerrain) moonTerrain = buildMoonTerrain();
    terrain.visible = s === 'earth';
    if (moonTerrain) moonTerrain.visible = s === 'moon';
    if (sky) sky.visible = s === 'earth';
    veil.visible = s === 'earth';
  }

  // ---------- Mise à jour par image ----------
  const warm = new T.Color(0xff8a45), noon = new T.Color(0xfff4e2), tmp = new T.Color(), tmp2 = new T.Color();
  const fogDay = new T.Color(0xc9d3dc), fogLow = new T.Color(0xe2a878), fogDusk = new T.Color(0x3c3450), fogNight = new T.Color(0x05070d);
  const hemiSkyDay = new T.Color(0x9cc0e6), hemiGround = new T.Color(0xa0714c);
  const moon = new T.Color(0x34466e), moonGround = new T.Color(0x1c1a24);
  const cloudLit = new T.Color(), cloudShade = new T.Color();
  let cameraRef = null;

  function update({ sunDir, sunLight, hemi, clouds, weather, windMs, dt, camera }) {
    cameraRef = camera || cameraRef;
    const W = SKY_BY_WEATHER[weather] || SKY_BY_WEATHER.clear;
    const elev = Math.asin(Math.max(-1, Math.min(1, sunDir.y))) * 180 / Math.PI;
    if (site === 'moon') {   // vide : lumière blanche dure, ciel noir, pas de brume ni de nuages
      sunLight.color.setHex(0xffffff);
      // Soleil rasant : le sol n'est éclairé que par la lumière renvoyée par le régolithe (diffusion de proximité).
      if (hemi) { hemi.color.setHex(0x6b6d75); hemi.groundColor.setHex(0x8a8a8e); hemi.intensity = 0.55; }
      if (scene.fog) scene.fog.density = 0;
      if (flareAnchor) { flareAnchor.position.copy(sunDir).multiplyScalar(600); flareAnchor.visible = elev > -1; }
      for (let i = 0; i < MAX_CLOUD_SHADOWS; i++) cloudUniforms.uCloud.value[i].w = 0;
      return;
    }
    const day = smooth(-4, 8, elev), high = smooth(2, 30, elev);

    if (sky) {
      const u = sky.material.uniforms;
      u.sunPosition.value.copy(sunDir).multiplyScalar(400000);
      u.turbidity.value = W.turbidity; u.rayleigh.value = W.rayleigh; u.mieCoefficient.value = W.mie; u.mieDirectionalG.value = W.g;
      if (cameraRef) sky.position.copy(cameraRef.position);
    }

    // Soleil : couleur chaude près de l'horizon, atténué par la couverture nuageuse (visuel).
    sunLight.color.copy(warm).lerp(noon, high);
    sunLight.intensity *= W.light;
    if (hemi) {   // la nuit : clair de lune bleuté pour garder la station lisible
      hemi.color.copy(moon).lerp(hemiSkyDay, day).lerp(fogDay, W.overcast * 0.6);
      hemi.groundColor.copy(moonGround).lerp(hemiGround, day);
      hemi.intensity = 0.45 + 0.25 * day;
    }

    // Brume : couleur de l'horizon selon la hauteur du soleil.
    tmp.copy(fogNight).lerp(fogDusk, smooth(-10, -2, elev)).lerp(fogLow, smooth(-2, 4, elev)).lerp(fogDay, high);
    tmp.lerp(tmp2.set(0x9aa3ad), W.overcast * day * 0.8);
    if (scene.fog) { scene.fog.color.copy(tmp); scene.fog.density = 0.0016 + 0.0016 * W.overcast; }

    // Nuages : sommet éclairé par le soleil (orangé au couchant), base dans l'ombre.
    cloudLit.copy(warm).lerp(noon, high).multiplyScalar(0.25 + 0.85 * day);
    cloudShade.copy(tmp).multiplyScalar(0.55 + 0.25 * day);
    const baseTint = tmp2.set(weather === 'overcast' ? 0x9aa0a8 : weather === 'partly' ? 0xe4e8ee : 0xffffff);
    clouds.children.forEach(g => g.children.forEach(s => {
      s.material.color.copy(cloudShade).lerp(cloudLit, s.userData.shade).multiply(baseTint);
    }));
    veil.material.opacity = W.overcast * (0.35 + 0.65 * day);
    veil.material.color.copy(cloudShade).lerp(cloudLit, 0.35).multiply(baseTint);

    // Ombres des nuages projetées au sol selon la direction du soleil.
    const U = cloudUniforms.uCloud.value, strength = (weather === 'overcast' ? 0.35 : 0.55) * day;
    for (let i = 0; i < MAX_CLOUD_SHADOWS; i++) {
      const c = clouds.children[i];
      if (!c || sunDir.y < 0.05) { U[i].w = 0; continue; }
      const k = c.position.y / sunDir.y;
      U[i].set(c.position.x - sunDir.x * k, c.position.z - sunDir.z * k, c.userData.radius, strength);
    }

    anemo.rotation.y -= windMs * 1.6 * dt;
    if (flareAnchor) { flareAnchor.position.copy(sunDir).multiplyScalar(600); flareAnchor.visible = elev > -1 && weather !== 'overcast'; }
  }

  return { sky, envSky, terrain, station, makeCloud, update, height, setSite, site: () => site };
}
