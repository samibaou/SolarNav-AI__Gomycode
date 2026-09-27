function degreesToRadians(value) { return value * Math.PI / 180; }

function createFallbackRenderer(container) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  container.replaceChildren(canvas);
  let state = null;

  function render() {
    canvas.width = Math.max(1, container.clientWidth * devicePixelRatio);
    canvas.height = Math.max(1, container.clientHeight * devicePixelRatio);
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#06101b"; ctx.fillRect(0, 0, w, h);
    if (!state) return;

    const cx = w * 0.52, cy = h * 0.68;
    ctx.strokeStyle = "#263f59"; ctx.lineWidth = 2 * devicePixelRatio;
    ctx.beginPath(); ctx.moveTo(w*.08, cy+45*devicePixelRatio); ctx.lineTo(w*.92, cy+45*devicePixelRatio); ctx.stroke();

    const sunAngle = degreesToRadians(state.sun.azimuth_deg - 90);
    const sx = cx + Math.cos(sunAngle) * w * .34;
    const sy = cy - h * .40 - Math.sin(degreesToRadians(state.sun.elevation_deg)) * h * .10;
    ctx.fillStyle = "#ffd66b"; ctx.beginPath(); ctx.arc(sx, sy, 16*devicePixelRatio, 0, Math.PI*2); ctx.fill();

    const tilt = degreesToRadians(state.panel.tilt_deg), panelWidth = 120 * devicePixelRatio;
    const dx = Math.cos(tilt)*panelWidth/2, dy = Math.sin(tilt)*panelWidth/2;
    ctx.strokeStyle = "#6bc7ff"; ctx.lineWidth = 12*devicePixelRatio;
    ctx.beginPath(); ctx.moveTo(cx-dx, cy+dy); ctx.lineTo(cx+dx, cy-dy); ctx.stroke();
    ctx.strokeStyle = "#8da6bd"; ctx.lineWidth = 5*devicePixelRatio;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx,cy+55*devicePixelRatio); ctx.stroke();
  }
  window.addEventListener("resize", render);
  return { mode: "canvas-fallback", update(nextState){ state = nextState; render(); } };
}

async function createThreeRenderer(container) {
  const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js");
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x06101b);
  const camera = new THREE.PerspectiveCamera(50, 1, .1, 100); camera.position.set(5,4,7); camera.lookAt(0,0,0);
  const renderer = new THREE.WebGLRenderer({antialias:true}); renderer.setPixelRatio(Math.min(devicePixelRatio,2)); container.replaceChildren(renderer.domElement);
  scene.add(new THREE.AmbientLight(0x8ab6d9, 1.2));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(14,14), new THREE.MeshStandardMaterial({color:0x25313c, roughness:1}));
  ground.rotation.x = -Math.PI/2; ground.position.y = -1; scene.add(ground);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(.45,.65,.55,24), new THREE.MeshStandardMaterial({color:0x75899c, metalness:.55, roughness:.45}));
  base.position.y = -.72; scene.add(base);
  const pivot = new THREE.Group(); pivot.position.y = -.2; scene.add(pivot);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(3.2,.12,1.8), new THREE.MeshStandardMaterial({color:0x176a9f, metalness:.25, roughness:.5})); pivot.add(panel);
  const sun = new THREE.Mesh(new THREE.SphereGeometry(.28,24,24), new THREE.MeshBasicMaterial({color:0xffd66b})); scene.add(sun);
  sun.add(new THREE.PointLight(0xffe7aa,45,30));

  function resize(){ const width=Math.max(1,container.clientWidth), height=Math.max(1,container.clientHeight); renderer.setSize(width,height,false); camera.aspect=width/height; camera.updateProjectionMatrix(); }
  function update(state){
    pivot.rotation.y = -degreesToRadians(state.panel.azimuth_deg);
    panel.rotation.x = degreesToRadians(state.panel.tilt_deg);
    const az=degreesToRadians(state.sun.azimuth_deg), el=degreesToRadians(state.sun.elevation_deg), r=5.5;
    sun.position.set(r*Math.cos(el)*Math.sin(az), r*Math.sin(el)+1, r*Math.cos(el)*Math.cos(az));
  }
  function loop(){ resize(); renderer.render(scene,camera); requestAnimationFrame(loop); } loop();
  return { mode:"three", update };
}

export async function initDigitalTwin(container) {
  try { return await createThreeRenderer(container); }
  catch (error) { console.warn("Three.js unavailable; using canvas fallback.", error); return createFallbackRenderer(container); }
}
