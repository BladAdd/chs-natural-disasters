/* ============================================================
   3D-Р—РµРјР»СЏ СЃ СЂРµР°Р»СЊРЅС‹РјРё РґР°РЅРЅС‹РјРё Рѕ Р§РЎ (USGS) Рё РєР°С‚Р°Р»РѕРіРѕРј РєР°С‚Р°СЃС‚СЂРѕС„
   ============================================================ */
import * as THREE from '../vendor/three.module.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const R = 2;                       // СЂР°РґРёСѓСЃ Р—РµРјР»Рё РІ СЃС†РµРЅРµ
const MR = R * 1.006;              // СЂР°РґРёСѓСЃ РјР°СЂРєРµСЂРѕРІ
const DEG = Math.PI / 180;

const MAG_COLORS = [
  { m: 2.5, c: [0.30, 0.85, 1.00] },
  { m: 4.0, c: [0.35, 1.00, 0.62] },
  { m: 5.5, c: [1.00, 0.86, 0.25] },
  { m: 6.5, c: [1.00, 0.55, 0.20] },
  { m: 99,  c: [1.00, 0.22, 0.35] }
];

const HAZ_COLORS = {
  tsunami:  [0.25, 0.80, 1.00],
  volcano:  [1.00, 0.45, 0.12],
  hurricane:[0.62, 0.55, 1.00],
  meteor:   [0.95, 0.95, 0.60],
  avalanche:[0.80, 0.95, 1.00]
};

function magColor(m) {
  for (const s of MAG_COLORS) if (m < s.m) return s.c;
  return MAG_COLORS[MAG_COLORS.length - 1].c;
}

function latLonToVec3(lat, lon, r = MR) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta)
  );
}

const fmtNum = (n) => n.toLocaleString('ru-RU');
const fmtDate = (ms) => new Date(ms).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
});

/* ============================================================
   РЎС†РµРЅР°
   ============================================================ */
let renderer, scene, camera, earthMesh, atmoMesh, starField;
let quakePoints, hazardPoints, pulsePoints, trailLine;
let matQuake, matHazard, matPulse;

let quakes = [];        // Р·Р°РіСЂСѓР¶РµРЅРЅС‹Рµ Р·РµРјР»РµС‚СЂСЏСЃРµРЅРёСЏ
let hazards = [];       // РєР°С‚Р°Р»РѕРі РєР°С‚Р°СЃС‚СЂРѕС„
let state = {
  region: 'world',
  minMag: 4.0,
  from: Date.UTC(1960, 0, 1),
  to: Date.now(),
  cursor: Date.now(),
  playing: false,
  speed: 30,            // В«РґРЅРµР№В» РІ СЃРµРєСѓРЅРґСѓ РїСЂРё СЃРєРѕСЂРѕСЃС‚Рё 1x
  live: false,
  showHazards: true,
  showTrail: true
};

const $files = {
  world: 'assets/data/quakes-world.csv',
  russia: 'assets/data/quakes-russia.csv',
  orenburg: 'assets/data/quakes-orenburg.csv'
};

function init() {
  const stage = $('#globeStage');
  if (!stage) return false;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(34, stage.clientWidth / stage.clientHeight, 0.1, 1000);
  camera.position.set(0, 1.4, 8.4);

  /* --- Р—РІС‘Р·РґС‹ --- */
  const starGeo = new THREE.BufferGeometry();
  const sPos = new Float32Array(1400 * 3);
  const sCol = new Float32Array(1400 * 3);
  for (let i = 0; i < 1400; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(180);
    sPos.set([v.x, v.y, v.z], i * 3);
    const c = 0.55 + Math.random() * 0.45;
    sCol.set([c, c * 0.97, c * 0.92], i * 3);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(sCol, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    size: 0.55, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.85
  })));

  /* --- РЎРѕР»РЅС†Рµ --- */
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(5, 3, 4);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x4466aa, 0.5));

  /* --- Р—РµРјР»СЏ: С€РµР№РґРµСЂ РґРµРЅСЊ/РЅРѕС‡СЊ --- */
  const loader = new THREE.TextureLoader();
  const dayMap = loader.load('assets/img/earth_day.jpg');
  const nightMap = loader.load('assets/img/earth_night.jpg');
  for (const t of [dayMap, nightMap]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; }

  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      dayMap:  { value: dayMap },
      nightMap:{ value: nightMap },
      sunDir:  { value: new THREE.Vector3(0.7, 0.25, 0.6).normalize() }
    },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform sampler2D dayMap; uniform sampler2D nightMap; uniform vec3 sunDir;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        vec3 n = normalize(vN);
        float diff = dot(n, normalize(sunDir));
        float day = smoothstep(-0.18, 0.28, diff);

        vec3 dayC   = texture2D(dayMap,  vUv).rgb;
        vec3 nightC = texture2D(nightMap, vUv).rgb;

        float city = smoothstep(0.18, 0.75, max(nightC.r, max(nightC.g, nightC.b)));

        vec3 ocean = vec3(0.02, 0.08, 0.18);
        float isOcean = step(dayC.b, dayC.r * 1.06) * step(dayC.b, dayC.g * 1.05);
        float spec = pow(max(diff, 0.0), 42.0) * isOcean * 0.35;

        vec3 col = dayC * (0.14 + 1.00 * max(diff, 0.0));
        col += spec;
        col = mix(col, nightC * 1.15 + ocean * 1.2, (1.0 - day) * 0.90);
        col += city * vec3(1.0, 0.88, 0.60) * (1.0 - day) * 1.15;

        float rim = pow(1.0 - max(dot(n, normalize(vView)), 0.0), 3.0);
        col += vec3(0.18, 0.42, 0.85) * rim * 0.40;

        gl_FragColor = vec4(col, 1.0);
      }`
  });

  earthMesh = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 96), earthMat);
  scene.add(earthMesh);

  /* --- РђС‚РјРѕСЃС„РµСЂР° --- */
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: new THREE.Vector3(0.7, 0.25, 0.6).normalize() } },
    vertexShader: `
      varying vec3 vN; varying vec3 vView;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      varying vec3 vN; varying vec3 vView;
      void main() {
        float rim = pow(1.0 - max(dot(normalize(vN), normalize(vView)), 0.0), 4.5);
        gl_FragColor = vec4(0.32, 0.58, 1.0, rim * 0.30);
      }`,
    transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
  });
  atmoMesh = new THREE.Mesh(new THREE.SphereGeometry(R * 1.045, 64, 64), atmoMat);
  scene.add(atmoMesh);

  buildMarkerLayers();
  bindControls();
  resize();
  window.addEventListener('resize', resize);
  window.__gl = { renderer, scene, camera, earthMesh, quakePoints, state, THREE };
  return true;
}

/* ============================================================
   РЎР»РѕРё РјР°СЂРєРµСЂРѕРІ
   ============================================================ */
function makePoints(maxCount) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxCount * 3), 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(maxCount * 3), 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(maxCount), 1));
  geo.setDrawRange(0, 0);
  return geo;
}

function pointsMaterial(extra = '') {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader: `
      attribute float aSize; attribute vec3 aColor;
      varying vec3 vColor; varying float vFade;
      uniform float uTime; ${extra}
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (260.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vFade;
      uniform float uOpacity;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        float core = smoothstep(0.5, 0.04, d);
        float glow = smoothstep(0.5, 0.18, d) * 0.55;
        float a = (core + glow) * uOpacity;
        gl_FragColor = vec4(vColor * (0.75 + core * 0.9), a);
      }`,
    transparent: true, depthTest: true, depthWrite: false
  });
}

function buildMarkerLayers() {
  const max = 70000;

  matQuake = pointsMaterial();
  quakePoints = new THREE.Points(makePoints(max), matQuake);
  quakePoints.renderOrder = 3;
  scene.add(quakePoints);

  matHazard = pointsMaterial();
  hazardPoints = new THREE.Points(makePoints(200), matHazard);
  hazardPoints.renderOrder = 4;
  scene.add(hazardPoints);

  matPulse = pointsMaterial(`
    attribute float aAge;
    uniform float uTime;`);
  matPulse.vertexShader = `
    attribute float aSize; attribute vec3 aColor; attribute float aAge;
    varying vec3 vColor;
    uniform float uTime;
    void main() {
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float grow = 1.0 + mod(uTime * 0.9 + aAge, 1.0) * 2.6;
      gl_PointSize = aSize * grow * (260.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`;
  const pulseGeo = makePoints(600);
  pulseGeo.setAttribute('aAge', new THREE.BufferAttribute(new Float32Array(600), 1));
  pulsePoints = new THREE.Points(pulseGeo, matPulse);
  pulsePoints.renderOrder = 5;
  scene.add(pulsePoints);

  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(200 * 3), 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(200 * 3), 3));
  trailGeo.setDrawRange(0, 0);
  trailLine = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false
  }));
  trailLine.renderOrder = 2;
  scene.add(trailLine);
}

/* ============================================================
   Р”Р°РЅРЅС‹Рµ
   ============================================================ */
async function loadHazards() {
  if (hazards.length) return;
  const r = await fetch('assets/data/hazards.json');
  hazards = (await r.json()).events || [];
}

async function loadQuakes(region) {
  const file = $files[region] || $files.world;
  setStatus('Р—Р°РіСЂСѓР¶Р°СЋ РєР°С‚Р°Р»РѕРі: ' + region);
  const txt = await (await fetch(file)).text();
  const lines = txt.trim().split('\n');
  quakes = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(';');
    if (p.length < 5) continue;
    const t = +p[0], lat = +p[1], lon = +p[2], mag = +p[3];
    if (!t || !isFinite(mag)) continue;
    quakes.push([t, lat, lon, mag, +p[4] || 0, p[5] || '']);
  }
  quakes.sort((a, b) => a[0] - b[0]);
  // РґРёР°РїР°Р·РѕРЅ РїРѕ РґР°РЅРЅС‹Рј
  state.from = quakes[0][0];
  state.to = quakes[quakes.length - 1][0];
  state.cursor = state.to;

  // РїРѕР»Р·СѓРЅРѕРє РјР°РіРЅРёС‚СѓРґС‹ РїРѕРґСЃС‚СЂР°РёРІР°РµРј РїРѕРґ СЂРµР°Р»СЊРЅС‹Р№ РјРёРЅРёРјСѓРј РІС‹Р±СЂР°РЅРЅРѕРіРѕ РєР°С‚Р°Р»РѕРіР°
  const dataMin = Math.max(1, Math.floor(quakes.reduce((m, q) => Math.min(m, q[3]), 99)));
  const magEl = $('#magRange');
  magEl.min = String(dataMin);
  state.minMag = dataMin;
  magEl.value = String(dataMin);
  $('#magLabel').textContent = 'M в‰Ґ ' + dataMin.toFixed(1);

  setStatus('РљР°С‚Р°Р»РѕРі Р·Р°РіСЂСѓР¶РµРЅ: ' + fmtNum(quakes.length) + ' СЃРѕР±С‹С‚РёР№');
  syncTimeline();
  renderMarkers();
}

async function loadLive() {
  setStatus('Р—Р°РїСЂРѕСЃ Р¶РёРІС‹С… РґР°РЅРЅС‹С… USGSвЂ¦');
  try {
    const r = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson');
    const j = await r.json();
    const now = Date.now();
    const rows = j.features.map(f => {
      const p = f.properties, c = f.geometry.coordinates;
      return [p.time, c[1], c[0], p.mag || 0, c[2] || 0, p.place || ''];
    }).filter(r2 => r2[3] >= state.minMag);

    state.live = true;
    state.from = now - 24 * 3600 * 1000;
    state.to = now;
    state.cursor = now;
    quakes = rows;
    renderMarkers();
    syncTimeline();
    setStatus('РџСЂСЏРјРѕР№ СЌС„РёСЂ USGS: ' + rows.length + ' Р·РµРјР»РµС‚СЂСЏСЃРµРЅРёР№ Р·Р° СЃСѓС‚РєРё');
    $$('#globeMode .mode-btn').forEach(b => b.classList.toggle('is-on', b.dataset.mode === 'live'));
  } catch (e) {
    setStatus('РќРµС‚ СЃРІСЏР·Рё СЃ USGS вЂ” РїРѕРєР°Р·Р°РЅ Р»РѕРєР°Р»СЊРЅС‹Р№ РєР°С‚Р°Р»РѕРі');
  }
}

/* ============================================================
   РћС‚СЂРёСЃРѕРІРєР° РјР°СЂРєРµСЂРѕРІ
   ============================================================ */
function renderMarkers() {
  const geo = quakePoints.geometry;
  const pos = geo.attributes.position.array;
  const col = geo.attributes.aColor.array;
  const siz = geo.attributes.aSize.array;

  const pulsePos = pulsePoints.geometry.attributes.position.array;
  const pulseCol = pulsePoints.geometry.attributes.aColor.array;
  const pulseSiz = pulsePoints.geometry.attributes.aSize.array;
  const pulseAge = pulsePoints.geometry.attributes.aAge.array;

  let n = 0, pn = 0;
  const visible = [];

  const lo = state.live ? state.from : state.from;
  const hi = state.cursor;

  for (const q of quakes) {
    if (q[0] > hi) break;
    if (q[3] < state.minMag) continue;
    if (state.live && q[0] < lo) continue;
    if (!state.live && q[0] < state.from) continue;

    const v = latLonToVec3(q[1], q[2]);
    pos.set([v.x, v.y, v.z], n * 3);
    const c = magColor(q[3]);
    col.set([c[0], c[1], c[2]], n * 3);
    siz[n] = 0.035 + Math.pow(Math.max(0, q[3] - 2), 1.55) * 0.030;
    visible.push(q);
    n++;
    if (n >= 69000) break;
  }
  geo.setDrawRange(0, n);
  geo.attributes.position.needsUpdate = true;
  geo.attributes.aColor.needsUpdate = true;
  geo.attributes.aSize.needsUpdate = true;

  // РїСѓР»СЊСЃ Сѓ СЃР°РјС‹С… СЃРІРµР¶РёС… (РґРѕ 90 СЃРѕР±С‹С‚РёР№) Рё Сѓ СЃР°РјС‹С… СЃРёР»СЊРЅС‹С…
  const recent = visible.slice(-90);
  const strongest = visible.slice().sort((a, b) => b[3] - a[3]).slice(0, 24);
  const pulseSet = [...new Set([...recent, ...strongest])];
  for (const q of pulseSet) {
    const v = latLonToVec3(q[1], q[2], R * 1.008);
    pulsePos.set([v.x, v.y, v.z], pn * 3);
    const c = magColor(q[3]);
    pulseCol.set([c[0], c[1], c[2]], pn * 3);
    pulseSiz[pn] = 0.03 + Math.pow(Math.max(0, q[3] - 2), 1.4) * 0.02;
    pulseAge[pn] = (pn * 0.37) % 1;
    pn++;
    if (pn >= 600) break;
  }
  pulsePoints.geometry.setDrawRange(0, pn);
  ['position', 'aColor', 'aSize', 'aAge'].forEach(k => { pulsePoints.geometry.attributes[k].needsUpdate = true; });

  // СЃР»РµРґ РїРѕСЃР»РµРґРЅРёС… СЃРѕР±С‹С‚РёР№
  renderTrail(visible.slice(-120));
  renderHazards(hi);

  // СЃС‚Р°С‚РёСЃС‚РёРєР°
  const maxM = visible.reduce((a, b) => Math.max(a, b[3]), 0);
  const maxQ = visible.reduce((a, b) => (b[3] > a[3] ? b : a), visible[0]);
  $('#stCount').textContent = fmtNum(visible.length);
  $('#stMax').textContent = maxM ? maxM.toFixed(1) : 'вЂ”';
  $('#stDate').textContent = state.live ? 'РїРѕСЃР»РµРґРЅРёРµ 24 С‡' : fmtDate(hi).replace(',', '');
  $('#stWhere').textContent = maxQ ? (maxQ[5] || 'вЂ”') : 'вЂ”';
}

function renderTrail(list) {
  const geo = trailLine.geometry;
  const pos = geo.attributes.position.array;
  const col = geo.attributes.color.array;
  if (!state.showTrail || list.length < 2) { geo.setDrawRange(0, 0); return; }

  const n = Math.min(list.length, 200);
  for (let i = 0; i < n; i++) {
    const q = list[list.length - n + i];
    const v = latLonToVec3(q[1], q[2], R * 1.012);
    pos.set([v.x, v.y, v.z], i * 3);
    const t = i / n;
    const c = magColor(q[3]);
    col.set([c[0] * t, c[1] * t, c[2] * t], i * 3);
  }
  geo.setDrawRange(0, n);
  geo.attributes.position.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
}

function renderHazards(cursorTime) {
  if (!state.showHazards) { hazardPoints.geometry.setDrawRange(0, 0); return; }
  const geo = hazardPoints.geometry;
  const pos = geo.attributes.position.array;
  const col = geo.attributes.aColor.array;
  const siz = geo.attributes.aSize.array;
  let n = 0;
  for (const h of hazards) {
    if (Date.parse(h.date) > cursorTime + 86400000 * 30) continue; // РїРѕРєР°Р·С‹РІР°РµРј РїСЂРѕС€РµРґС€РёРµ + РјРµСЃСЏС† РІРїРµСЂС‘Рґ
    const v = latLonToVec3(h.lat, h.lon, R * 1.004);
    pos.set([v.x, v.y, v.z], n * 3);
    const c = HAZ_COLORS[h.type] || [1, 1, 1];
    col.set([c[0], c[1], c[2]], n * 3);
    siz[n] = 0.055 + Math.min(h.deaths / 6000, 0.07);
    n++;
  }
  geo.setDrawRange(0, n);
  geo.attributes.position.needsUpdate = true;
  geo.attributes.aColor.needsUpdate = true;
  geo.attributes.aSize.needsUpdate = true;
}

/* ============================================================
   РљР°РјРµСЂР° / РІСЂР°С‰РµРЅРёРµ
   ============================================================ */
let spin = { rot: 0, vel: 0.04, dragging: false, lastX: 0, lastY: 0, pitch: 0.28, auto: true };

function bindControls() {
  const el = renderer.domElement;
  el.style.touchAction = 'none';

  el.addEventListener('pointerdown', e => {
    spin.dragging = true; spin.auto = false;
    spin.lastX = e.clientX; spin.lastY = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (!spin.dragging) return;
    spin.rot -= (e.clientX - spin.lastX) * 0.006;
    spin.pitch = Math.max(-1.2, Math.min(1.2, spin.pitch + (e.clientY - spin.lastY) * 0.004));
    spin.lastX = e.clientX; spin.lastY = e.clientY;
    updateCamera();
  });
  el.addEventListener('pointerup', e => { spin.dragging = false; el.releasePointerCapture(e.pointerId); });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    camera.position.multiplyScalar(1 + Math.sign(e.deltaY) * 0.09);
    camera.position.clampLength(2.9, 11);
  }, { passive: false });

  // РєР»РёРє РїРѕ РјР°СЂРєРµСЂСѓ
  el.addEventListener('click', e => {
    if (Math.abs(e.clientX - spin.lastX) > 5 && spin.dragging) return;
    pick(e);
  });
}

function updateCamera() {
  const d = camera.position.length();
  camera.position.set(
    d * Math.cos(spin.pitch) * Math.sin(spin.rot),
    d * Math.sin(spin.pitch),
    d * Math.cos(spin.pitch) * Math.cos(spin.rot)
  );
  camera.lookAt(0, 0, 0);
}

function resize() {
  const stage = $('#globeStage');
  if (!stage || !renderer) return;
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  camera.aspect = stage.clientWidth / stage.clientHeight;
  camera.updateProjectionMatrix();
  // РїРѕРґРіРѕРЅСЏРµРј СЂР°СЃСЃС‚РѕСЏРЅРёРµ С‚Р°Рє, С‡С‚РѕР±С‹ СЃС„РµСЂР° С†РµР»РёРєРѕРј РїРѕРјРµС‰Р°Р»Р°СЃСЊ РІ РєР°РґСЂ
  const fitR = R * 1.12;
  const vFov = camera.fov * DEG;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = Math.max(fitR / Math.sin(vFov / 2), fitR / Math.sin(hFov / 2));
  const dir = camera.position.clone().normalize();
  camera.position.copy(dir.multiplyScalar(Math.max(dist, 2.9)));
  camera.lookAt(0, 0, 0);
}

/* --- РІС‹Р±РѕСЂ РјР°СЂРєРµСЂР° --- */
const ray = new THREE.Raycaster();
function pick(ev) {
  if (!quakePoints || quakePoints.geometry.drawRange.count === 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  ray.params.Points.threshold = 0.06;
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObject(quakePoints, false);
  if (hits.length) {
    const i = hits[0].index;
    showInfo(quakes[i]);
  } else {
    const hh = ray.intersectObject(hazardPoints, false);
    if (hh.length) {
      let best = null, bd = 1e9;
      const gi = hh[0].index;
      const target = hazards.filter(h => Date.parse(h.date) <= state.cursor + 86400000 * 30)[gi];
      if (target) showHazInfo(target);
    }
  }
}

function showInfo(q) {
  const d = new Date(q[0]);
  $('#infoTitle').textContent = 'M ' + q[3].toFixed(1) + ' В· ' + (q[5] || 'СЂРµРіРёРѕРЅ РЅРµ СѓРєР°Р·Р°РЅ');
  $('#infoSub').textContent = fmtDate(q[0]);
  $('#infoBody').innerHTML =
    '<b>РњР°РіРЅРёС‚СѓРґР°:</b> ' + q[3].toFixed(1) + '<br>' +
    '<b>Р“Р»СѓР±РёРЅР°:</b> ' + q[4] + ' РєРј<br>' +
    '<b>РљРѕРѕСЂРґРёРЅР°С‚С‹:</b> ' + q[1].toFixed(2) + 'В° СЃ.С€., ' + q[2].toFixed(2) + 'В° РІ.Рґ.<br>' +
    '<b>Р”Р°С‚Р° (UTC):</b> ' + d.toISOString().replace('T', ' ').slice(0, 16) + '<br>' +
    '<span class="small">РСЃС‚РѕС‡РЅРёРє: USGS Earthquake Hazards Program</span>';
  $('#infoBox').classList.add('is-on');
}

function showHazInfo(h) {
  $('#infoTitle').textContent = h.name;
  $('#infoSub').textContent = new Date(h.date).toLocaleDateString('ru-RU');
  $('#infoBody').innerHTML =
    '<b>РўРёРї:</b> ' + ({ tsunami: 'С†СѓРЅР°РјРё', volcano: 'РІСѓР»РєР°РЅ', hurricane: 'С†РёРєР»РѕРЅ/СѓСЂР°РіР°РЅ', meteor: 'РјРµС‚РµРѕСЂРёС‚', avalanche: 'Р»Р°РІРёРЅР°' }[h.type] || h.type) + '<br>' +
    '<b>РџРѕРіРёР±Р»Рѕ:</b> ' + (h.deaths ? fmtNum(h.deaths) + ' С‡РµР».' : 'РЅРµС‚ РґР°РЅРЅС‹С…') + '<br>' +
    '<b>РљРѕРѕСЂРґРёРЅР°С‚С‹:</b> ' + h.lat + 'В°, ' + h.lon + 'В°<br><br>' +
    '<span>' + h.text + '</span>';
  $('#infoBox').classList.add('is-on');
}

/* ============================================================
   РџР°РЅРµР»СЊ СѓРїСЂР°РІР»РµРЅРёСЏ
   ============================================================ */
function setStatus(s) { const el = $('#globeStatus'); if (el) el.textContent = s; }

function syncTimeline() {
  const t = $('#timeRange');
  t.min = state.from; t.max = state.to; t.value = state.cursor;
  const d = new Date(+state.cursor);
  $('#timeLabel').textContent = state.live
    ? 'РїРѕСЃР»РµРґРЅРёРµ 24 С‡Р°СЃР°'
    : d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

function bindPanel() {
  // СЂРµР¶РёРјС‹
  $$('#globeMode .mode-btn').forEach(b => b.addEventListener('click', async () => {
    $$('#globeMode .mode-btn').forEach(x => x.classList.remove('is-on'));
    b.classList.add('is-on');
    const mode = b.dataset.mode;
    if (mode === 'live') { await loadLive(); }
    else {
      state.live = false;
      await loadQuakes(b.dataset.region || state.region);
    }
  }));

  // СЂРµРіРёРѕРЅ
  $('#regionSel').addEventListener('change', async e => {
    state.region = e.target.value;
    state.live = false;
    await loadQuakes(state.region);
  });

  // РјР°РіРЅРёС‚СѓРґР°
  $('#magRange').addEventListener('input', e => {
    state.minMag = +e.target.value;
    $('#magLabel').textContent = 'M в‰Ґ ' + state.minMag.toFixed(1);
    renderMarkers();
  });

  // РїРѕР»Р·СѓРЅРѕРє РІСЂРµРјРµРЅРё
  const t = $('#timeRange');
  t.addEventListener('input', e => {
    state.cursor = +e.target.value;
    state.playing = false;
    $('#playBtn').classList.remove('is-on');
    $('#playBtn').textContent = 'в–¶ РРіСЂР°С‚СЊ';
    renderMarkers();
    syncTimeline();
  });

  // РєРЅРѕРїРєР° РґР°С‚С‹
  $('#goDate').addEventListener('click', () => {
    const v = $('#dateInput').value;
    if (!v) return;
    const ms = Date.parse(v + 'T12:00:00Z');
    if (!isFinite(ms)) return;
    state.live = false;
    state.cursor = ms;
    state.playing = false;
    $('#playBtn').classList.remove('is-on');
    $('#playBtn').textContent = 'в–¶ РРіСЂР°С‚СЊ';
    if (ms < state.from || ms > state.to) {
      // РµСЃР»Рё РґР°С‚Р° РІРЅРµ РґРёР°РїР°Р·РѕРЅР° вЂ” РїРµСЂРµР·Р°РіСЂСѓР·РёРј РїРѕРґС…РѕРґСЏС‰РёР№ СЂРµРіРёРѕРЅ
      setStatus('Р”Р°С‚Р° РІРЅРµ РґРёР°РїР°Р·РѕРЅР° РєР°С‚Р°Р»РѕРіР° вЂ” РїРѕРєР°Р·С‹РІР°СЋ СЃРѕР±С‹С‚РёСЏ СЂСЏРґРѕРј');
    }
    renderMarkers();
    syncTimeline();
  });

  // play/pause
  $('#playBtn').addEventListener('click', () => {
    state.playing = !state.playing;
    $('#playBtn').classList.toggle('is-on', state.playing);
    $('#playBtn').textContent = state.playing ? 'вЏё РџР°СѓР·Р°' : 'в–¶ РРіСЂР°С‚СЊ';
    if (state.playing && state.cursor >= state.to - 1000) {
      state.cursor = state.from;
    }
  });

  // СЃРєРѕСЂРѕСЃС‚СЊ
  $('#speedRange').addEventListener('input', e => {
    state.speed = +e.target.value;
    $('#speedLabel').textContent = state.speed + 'Г—';
  });

  // СЃР»РѕРё
  $('#hazToggle').addEventListener('change', e => {
    state.showHazards = e.target.checked; renderMarkers();
  });
  $('#trailToggle').addEventListener('change', e => {
    state.showTrail = e.target.checked; renderMarkers();
  });

  // СЃР»РѕРё РєР°С‚Р°СЃС‚СЂРѕС„
  $$('#hazList .haz-row').forEach(row => row.addEventListener('click', async () => {
    await loadHazards();
    const h = hazards.find(x => x.id === row.dataset.id);
    if (!h) return;
    const ms = Date.parse(h.date);
    if (ms < state.from || ms > state.to) {
      state.region = 'world'; state.live = false;
      await loadQuakes('world');
    }
    state.cursor = ms;
    state.playing = false;
    renderMarkers();
    syncTimeline();
    showHazInfo(h);
    // РїРѕРІРµСЂРЅСѓС‚СЊ РіР»РѕР±СѓСЃ Рє СЃРѕР±С‹С‚РёСЋ
    spin.auto = false;
    spin.rot = (h.lon + 180) * DEG * -1;
    spin.pitch = (h.lat * DEG) * 0.8;
    updateCamera();
  }));

  $('#infoClose').addEventListener('click', () => $('#infoBox').classList.remove('is-on'));

  // РІСЂР°С‰РµРЅРёРµ
  $('#rotateBtn').addEventListener('click', () => {
    spin.auto = !spin.auto;
    $('#rotateBtn').classList.toggle('is-on', spin.auto);
  });
  spin.auto = true;
  $('#rotateBtn').classList.add('is-on');
}

/* ============================================================
   Р¦РёРєР» СЂРµРЅРґРµСЂР°
   ============================================================ */
let clock, running = false, inited = false;

function tick() {
  if (!inited) return;
  requestAnimationFrame(tick);
  if (!running) return;

  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  matQuake.uniforms.uTime.value = t;
  matHazard.uniforms.uTime.value = t;
  matPulse.uniforms.uTime.value = t;

  if (spin.auto && !spin.dragging) spin.rot += dt * 0.055;
  updateCamera();

  if (state.playing) {
    const stepMs = dt * 1000 * state.speed * 86400000 / 30; // В«РґРЅРµР№ РІ СЃРµРєСѓРЅРґСѓВ»
    state.cursor += stepMs;
    if (state.cursor >= state.to) { state.cursor = state.to; state.playing = false; $('#playBtn').classList.remove('is-on'); $('#playBtn').textContent = 'в–¶ РРіСЂР°С‚СЊ'; }
    renderMarkers();
    syncTimeline();
  }

  // СЃРѕР»РЅС†Рµ РјСЏРіРєРѕ СЃР»РµРґСѓРµС‚ Р·Р° РєР°РјРµСЂРѕР№ вЂ” РіР»РѕР±СѓСЃ РІСЃРµРіРґР° С…РѕСЂРѕС€Рѕ РѕСЃРІРµС‰С‘РЅ
  const sunDir = earthMesh.material.uniforms.sunDir.value;
  const a = spin.rot + 0.62;
  sunDir.set(Math.sin(a) * 0.92, 0.34, Math.cos(a) * 0.92).normalize();
  atmoMesh.material.uniforms.sunDir.value.copy(sunDir);

  renderer.render(scene, camera);
}

/* ============================================================
   Р—Р°РїСѓСЃРє
   ============================================================ */
export function initGlobe() {
  if (inited) return;
  const ok = (() => { try { return init(); } catch (e) { console.error(e); return false; } })();
  if (!ok) { setStatus('WebGL РЅРµРґРѕСЃС‚СѓРїРµРЅ вЂ” 3D-РєР°СЂС‚Р° РЅРµ РјРѕР¶РµС‚ Р±С‹С‚СЊ РїРѕРєР°Р·Р°РЅР°'); return; }

  bindPanel();
  clock = new THREE.Clock();
  inited = true;          // СЃРЅР°С‡Р°Р»Р° С„Р»Р°Рі, Р·Р°С‚РµРј С†РёРєР»: tick() РїСЂРѕРІРµСЂСЏРµС‚ РµРіРѕ РЅР° РІС…РѕРґРµ
  tick();

  (async () => {
    await loadHazards();
    await loadQuakes('world');
  })();
}

export function setGlobeActive(on) {
  if (!inited) return;
  running = on;
  if (on) clock.getDelta(); // СЃР±СЂРѕСЃ, С‡С‚РѕР±С‹ РЅРµ Р±С‹Р»Рѕ РїСЂС‹Р¶РєР° РїРѕСЃР»Рµ РїР°СѓР·С‹
}

export function resetGlobeCamera() {
  spin.auto = true; spin.rot = 0; spin.pitch = 0.28;
  camera.position.set(0, 1.4, 6.2);
  updateCamera();
}

/* --- РџСѓР±Р»РёС‡РЅС‹Р№ API РґР»СЏ РѕСЃРЅРѕРІРЅРѕРіРѕ СЃРєСЂРёРїС‚Р° РїСЂРµР·РµРЅС‚Р°С†РёРё --- */
window.globeAPI = {
  /** Р»РµРЅРёРІС‹Р№ Р·Р°РїСѓСЃРє: СЃРѕР·РґР°С‘С‚ СЃС†РµРЅСѓ С‚РѕР»СЊРєРѕ РєРѕРіРґР° СЃР»Р°Р№Рґ РѕС‚РєСЂС‹С‚ РїРµСЂРІС‹Р№ СЂР°Р· */
  ensure() {
    if (!inited) {
      const slide = $('.globe-slide');
      if (slide && slide.classList.contains('is-active')) initGlobe();
    }
  },
  active(on) { setGlobeActive(on); },
  reset() { if (inited) resetGlobeCamera(); },
  ready() { return inited; }
};