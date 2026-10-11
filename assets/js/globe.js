/* ============================================================
   3D-Земля «Хроника стихии»
   Настоящая WebGL-сфера + честная работа со временем.

   Ключевые идеи:
   • данные в типизированных массивах, позиции считаются ОДИН раз;
   • обновление кадра = смена drawRange (O(1)), а не перебор событий;
   • два режима времени: ХРОНИКА (окно вокруг даты) и НАКОПЛЕНИЕ (всё до даты);
   • Солнце реально соответствует выбранной дате;
   • камера умеет подлетать к событию;
   • если WebGL недоступен — рисуем ту же карту в 2D.
   ============================================================ */

import * as THREE from '../vendor/three.module.js';
import { DataStore, WINDOW_PRESETS, haversineKm, regionBox } from './data-store.js';

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const R  = 2.0;                     // радиус Земли
const MR = R * 1.008;                // поверхность маркеров
const DEG = Math.PI / 180;

const MODE_CHRONO = 'chrono';        // окно вокруг даты
const MODE_CUMUL  = 'cumulative';    // всё до даты

/* ---------- вспомогательное ---------- */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const fmtInt = n => Math.round(n).toLocaleString('ru-RU');

function fmtDate(ms, withTime) {
  const d = new Date(ms);
  const s = d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  return withTime ? s + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : s;
}
function fmtDuration(ms) {
  const d = Math.abs(ms) / 86400000;
  if (d < 1 / 24) return Math.round(d * 1440) + ' мин';
  if (d < 2) return Math.round(d * 24) + ' ч';
  return fmtInt(d) + ' сут';
}

/* ---------- геометрия: lat/lon → точка на сфере ---------- */
const _v = new THREE.Vector3();
function llToVec(lat, lon, r, out) {
  const phi = (90 - lat) * DEG, theta = (lon + 180) * DEG;
  const o = out || _v;
  return o.set(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta)
  );
}
/* Промежуточная точка на дуге great-circle (slerp) — для линий по поверхности */
function slerpVec(a, b, t, r, out) {
  const dot = clamp(a.dot(b), -1, 1);
  const omega = Math.acos(dot);
  if (omega < 1e-6) return out.copy(b).setLength(r);
  const s = Math.sin(omega);
  return out.set(
    (a.x * Math.sin((1 - t) * omega) + b.x * Math.sin(t * omega)) / s,
    (a.y * Math.sin((1 - t) * omega) + b.y * Math.sin(t * omega)) / s,
    (a.z * Math.sin((1 - t) * omega) + b.z * Math.sin(t * omega)) / s
  ).setLength(r);
}

function magColor(m) {
  if (m < 4.0) return [0.24, 0.78, 1.00];
  if (m < 5.0) return [0.30, 0.95, 0.62];
  if (m < 6.0) return [1.00, 0.84, 0.22];
  if (m < 7.0) return [1.00, 0.52, 0.16];
  return [1.00, 0.22, 0.33];
}
function magSize(m) { return 0.030 + Math.pow(Math.max(0, m - 2.0), 1.6) * 0.029; }

const HAZ_COLOR = {
  tsunami:   [0.25, 0.80, 1.00],
  volcano:   [1.00, 0.46, 0.12],
  hurricane: [0.62, 0.55, 1.00],
  meteor:    [0.96, 0.92, 0.55],
  avalanche: [0.80, 0.95, 1.00]
};
const HAZ_TITLE = {
  tsunami: 'Цунами', volcano: 'Вулкан', hurricane: 'Циклон',
  meteor: 'Метеорит', avalanche: 'Лавина'
};

/* Подсолнечная точка для заданной даты — чтобы терминатор был настоящим */
function sunDirectionFor(dateMs, out) {
  const d = new Date(dateMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const dayOfYear = (dateMs - start) / 86400000;
  const decl = -23.44 * DEG * Math.cos(2 * Math.PI * (dayOfYear + 10) / 365.25);
  const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60;
  const subLon = -15 * (utcHours - 12);              // где сейчас полдень
  return llToVec(decl / DEG, subLon, 1, out).normalize();
}

/* ============================================================
   Приложение
   ============================================================ */
class GlobeApp {
  constructor() {
    this.store = new DataStore();
    this.ok = false;                 // WebGL доступен?
    this.ready = false;

    this.state = {
      mode: MODE_CHRONO,
      windowId: 'month',
      cursor: Date.now(),
      speed: 24,                     // «единиц в секунду» (см. SPEED_PRESETS)
      playing: false,
      showQuakes: true,
      showHazards: true,
      showGrid: true,
      showLabels: true,
      showTrail: true
    };

    this.cam = { lon: -55, lat: 20, dist: 7.0, tLon: -55, tLat: 20, tDist: 7.0 };
    this.autoRotate = false;
    this.hoverIndex = -1;
    this.info = { kind: null, i: -1 };
  }

  /* ---------------- инициализация ---------------- */
  init() {
    const stage = $('#globeStage');
    if (!stage) return;

    try {
      this.initGL(stage);
      this.ok = true;
    } catch (err) {
      console.warn('WebGL недоступен:', err);
      this.initFallback(stage);
      this.ok = false;
    }

    this.bindUI();
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.loop = this.loop.bind(this);
    this.lastT = performance.now();
    requestAnimationFrame(this.loop);

    this.bootstrap();
  }

  async bootstrap() {
    this.setStatus('Загружаю каталог землетрясений…');
    try {
      await this.store.loadHazards();
      await this.store.loadRegion('world', p => this.setStatus('Каталог: ' + Math.round(p * 100) + '%'));
      if (this.ok) this.buildQuakeGeometry();
      const b = this.store.bounds();
      this.state.cursor = b.to;
      this.setSliderBounds(b);
      this.refresh(true);
      this.ready = true;
      const v0 = this.viewToSunlitSide();
      this.cam.lon = this.cam.tLon = v0.lon;
      this.cam.lat = this.cam.tLat = v0.lat;
      this.setStatus('Готово. Каталог: ' + fmtInt(this.store.catalog().count) + ' событий');
    } catch (e) {
      this.setStatus('Ошибка загрузки: ' + e.message);
    }
  }

  /* ---------------- 3D ---------------- */
  initGL(stage) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    stage.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 900);

    /* --- звёзды --- */
    const N = 1600, sp = new Float32Array(N * 3), sc = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(220);
      sp.set([v.x, v.y, v.z], i * 3);
      const b = 0.5 + Math.random() * 0.5;
      sc.set([b, b * 0.97, b * 0.9], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(sc, 3));
    this.scene.add(new THREE.Points(sg, new THREE.PointsMaterial({
      size: 0.6, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false
    })));

    /* --- Земля: дневная карта + ночные огни + солнце по дате --- */
    const loader = new THREE.TextureLoader();
    const dayT = loader.load('assets/img/earth_day.jpg');
    const nightT = loader.load('assets/img/earth_night.jpg');
    dayT.colorSpace = nightT.colorSpace = THREE.SRGBColorSpace;

    this.earthMat = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: dayT }, nightMap: { value: nightT },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        dim: { value: 0 }
      },
      vertexShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main() {
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform sampler2D dayMap; uniform sampler2D nightMap;
        uniform vec3 sunDir; uniform float dim;
        varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main() {
          vec3 n = normalize(vN);
          float diff = dot(n, normalize(sunDir));
          float day = smoothstep(-0.16, 0.26, diff);

          vec3 dayC   = texture2D(dayMap,  vUv).rgb;
          vec3 nightC = texture2D(nightMap, vUv).rgb;

          float city = smoothstep(0.16, 0.72, max(nightC.r, max(nightC.g, nightC.b)));
          float isOcean = step(dayC.b, dayC.r * 1.07) * step(dayC.b, dayC.g * 1.06);
          float spec = pow(max(diff, 0.0), 46.0) * isOcean * 0.30;

          vec3 col = dayC * (0.16 + 1.02 * max(diff, 0.0)) + spec;
          // ночная сторона остаётся читаемой: видны города и контуры континентов
          vec3 nightCol = nightC * 1.25 + dayC * 0.20 + vec3(0.030, 0.046, 0.092);
          col = mix(col, nightCol, (1.0 - day) * 0.93);
          col += city * vec3(1.0, 0.86, 0.55) * (1.0 - day) * 1.25;
          col *= (1.0 - dim * 0.42);

          float rim = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 3.2);
          col += vec3(0.16, 0.38, 0.80) * rim * 0.42;

          gl_FragColor = vec4(col, 1.0);
        }`
    });

    this.earth = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), this.earthMat);
    this.scene.add(this.earth);

    /* --- атмосфера --- */
    this.atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.05, 64, 64),
      new THREE.ShaderMaterial({
        uniforms: { sunDir: { value: new THREE.Vector3(1, 0, 0) } },
        vertexShader: `
          varying vec3 vN; varying vec3 vV;
          void main() {
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vV = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: `
          uniform vec3 sunDir;
          varying vec3 vN; varying vec3 vV;
          void main() {
            vec3 n = normalize(vN);
            float rim = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 4.0);
            float lit = smoothstep(-0.35, 0.5, dot(n, normalize(sunDir)));
            gl_FragColor = vec4(mix(vec3(0.12,0.28,0.6), vec3(0.35,0.62,1.0), lit), rim * 0.55);
          }`,
        transparent: true, side: THREE.BackSide,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    this.scene.add(this.atmo);

    /* --- сетка координат --- */
    this.grid = this.buildGraticule();
    this.scene.add(this.grid);

    /* --- рамка региона --- */
    this.regionBox = this.makeLine(R * 1.004, 0x22d3ee, 0.55);
    this.scene.add(this.regionBox);

    /* --- маркеры землетрясений --- */
    this.quakeGeo = this.makeMarkerGeometry(70000);
    this.quakePts = new THREE.Points(this.quakeGeo, this.makeMarkerMaterial(true));
    this.quakePts.frustumCulled = false;
    this.quakePts.renderOrder = 3;
    this.scene.add(this.quakePts);

    /* --- катастрофы --- */
    this.hazGeo = this.makeMarkerGeometry(64);
    this.hazPts = new THREE.Points(this.hazGeo, this.makeMarkerMaterial(true));
    this.hazPts.frustumCulled = false;
    this.hazPts.renderOrder = 4;
    this.scene.add(this.hazPts);

    /* --- кольца «сейсмических волн» для сильных событий --- */
    this.waveMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    this.waveLine = new THREE.Line(this.makeCircleGeometry(96), this.waveMat);
    this.waveLine.frustumCulled = false;
    this.waveLine.visible = false;
    this.scene.add(this.waveLine);

    /* --- связи афтершоков (по поверхности) --- */
    const AFT_MAX = 128, AFT_STEPS = 12;
    this.aftGeo = new THREE.BufferGeometry();
    this.aftGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(AFT_MAX * AFT_STEPS * 2 * 3), 3));
    this.aftGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(AFT_MAX * AFT_STEPS * 2 * 3), 3));
    this.aftGeo.setDrawRange(0, 0);
    this.aftSteps = AFT_STEPS;
    this.aftMax = AFT_MAX;
    this.aftLine = new THREE.LineSegments(this.aftGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false
    }));
    this.aftLine.frustumCulled = false;
    this.scene.add(this.aftLine);

    /* --- подписи --- */
    const layer = $('#globeLabels');
    if (layer) this.labelLayer = layer;

    /* --- мышь --- */
    this.bindMouse(this.renderer.domElement);

    /* маленький помощник для отладки/тестов */
    this.__ll = (lat, lon) => llToVec(lat, lon, MR, new THREE.Vector3());
    this.__THREE__ = THREE;
  }

  buildGraticule() {
    const g = new THREE.Group();
    const r = R * 1.0015;
    const mk = (color, opacity, seg) => {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += seg) {
        for (let i = 0; i < 12; i++) {
          pts.push(llToVec(-90 + (180 * i) / 12, lon, r, new THREE.Vector3()));
          pts.push(llToVec(-90 + (180 * (i + 1)) / 12, lon, r, new THREE.Vector3()));
        }
      }
      for (let lat = -60; lat <= 60; lat += seg) {
        for (let i = 0; i < 24; i++) {
          pts.push(llToVec(lat, -180 + (360 * i) / 24, r, new THREE.Vector3()));
          pts.push(llToVec(lat, -180 + (360 * (i + 1)) / 24, r, new THREE.Vector3()));
        }
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color, transparent: true, opacity, depthWrite: false
      }));
    };
    g.add(mk(0x5f7fbf, 0.16, 30));
    // экватор и нулевой меридиан — ярче
    const main = [];
    for (let i = 0; i < 120; i++) {
      main.push(llToVec(0, -180 + 3 * i, r * 1.0005, new THREE.Vector3()));
      main.push(llToVec(0, -180 + 3 * (i + 1), r * 1.0005, new THREE.Vector3()));
    }
    for (let i = 0; i < 60; i++) {
      main.push(llToVec(-90 + 3 * i, 0, r * 1.0005, new THREE.Vector3()));
      main.push(llToVec(-90 + 3 * (i + 1), 0, r * 1.0005, new THREE.Vector3()));
    }
    g.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(main),
      new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.32, depthWrite: false })
    ));
    return g;
  }

  makeCircleGeometry(seg) {
    const pts = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  makeLine(r, color, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(400 * 3), 3));
    geo.setDrawRange(0, 0);
    const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color, transparent: true, opacity, depthWrite: false
    }));
    l.frustumCulled = false;
    return l;
  }

  makeMarkerGeometry(max) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setAttribute('aColor',   new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(new Float32Array(max), 1));
    geo.setAttribute('aAlpha',   new THREE.BufferAttribute(new Float32Array(max), 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.2);
    return geo;
  }

  makeMarkerMaterial(useAlpha) {
    return new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 215 } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        varying vec3 vColor; varying float vAlpha;
        uniform float uScale;
        void main() {
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float px = aSize * uScale / max(0.001, -mv.z);
          gl_PointSize = vAlpha <= 0.001 ? 0.0 : clamp(px, 1.5, 46.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          if (d > 0.5 || vAlpha <= 0.001) discard;
          float core = smoothstep(0.5, 0.06, d);
          float halo = smoothstep(0.5, 0.22, d);
          float a = clamp(core * 0.95 + halo * 0.4, 0.0, 1.0) * vAlpha;
          gl_FragColor = vec4(vColor * (0.72 + core * 0.9), a);
        }`,
      transparent: true, depthTest: true, depthWrite: false
    });
  }

  /* ---------------- 2D-запасной вариант ---------------- */
  initFallback(stage) {
    this.c2d = document.createElement('canvas');
    this.c2d.style.cssText = 'width:100%;height:100%;display:block;background:#050a18';
    stage.appendChild(this.c2d);
    this.ctx2d = this.c2d.getContext('2d');
    this.fallbackMsg = document.createElement('div');
    this.fallbackMsg.className = 'globe-status';
    stage.appendChild(this.fallbackMsg);
    this.setStatus('WebGL недоступен — показана плоская карта (данные те же)');
    this.bindMouse(this.c2d);
  }

  draw2D() {
    if (!this.ctx2d) return;
    const c = this.ctx2d, w = this.c2d.width, h = this.c2d.height;
    c.fillStyle = '#050a18'; c.fillRect(0, 0, w, h);
    if (this.dayImg) {
      c.globalAlpha = 0.92;
      c.drawImage(this.dayImg, 0, 0, w, h);
      c.fillStyle = 'rgba(4,8,20,.40)'; c.fillRect(0, 0, w, h);
      c.globalAlpha = 1;
    }

    const px = lon => (lon + 180) / 360 * w;
    const py = lat => (90 - lat) / 180 * h;

    // рамка выбранного региона
    const box = regionBox(this.store.region);
    if (box) {
      c.strokeStyle = 'rgba(34,211,238,.9)';
      c.lineWidth = 2;
      c.strokeRect(px(box.minLon), py(box.maxLat),
                   px(box.maxLon) - px(box.minLon), py(box.minLat) - py(box.maxLat));
    }

    const cat = this.store.catalog();
    const { lo, hi } = this.range || { lo: 0, hi: 0 };
    if (cat && this.state.showQuakes) {
      for (let i = lo; i < hi; i++) {
        if (cat.mag[i] < this.store.minMag) continue;
        const col = magColor(cat.mag[i]);
        const s = Math.max(1.6, magSize(cat.mag[i]) * 40);
        c.fillStyle = `rgb(${col.map(x => Math.round(x * 255)).join(',')})`;
        c.beginPath();
        c.arc(px(cat.lon[i]), py(cat.lat[i]), s, 0, 6.2832);
        c.fill();
      }
    }
    if (this.state.showHazards && this.visibleHazards) {
      for (const hz of this.visibleHazards) {
        const col = HAZ_COLOR[hz.type] || [1, 1, 1];
        c.strokeStyle = `rgba(${col.map(x => Math.round(x * 255)).join(',')},.95)`;
        c.lineWidth = 2;
        c.beginPath();
        c.arc(px(hz.lon), py(hz.lat), 8, 0, 6.2832);
        c.stroke();
      }
    }
  }

  /* ---------------- геометрия маркеров ---------------- */
  buildQuakeGeometry() {
    const cat = this.store.catalog();
    if (!cat) return;
    const n = cat.count;
    const pos = this.quakeGeo.attributes.position.array;
    const col = this.quakeGeo.attributes.aColor.array;
    const siz = this.quakeGeo.attributes.aSize.array;
    const alp = this.quakeGeo.attributes.aAlpha.array;
    const v = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      llToVec(cat.lat[i], cat.lon[i], MR, v);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      const c = magColor(cat.mag[i]);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      siz[i] = magSize(cat.mag[i]);
      alp[i] = 1;
    }
    ['position', 'aColor', 'aSize', 'aAlpha'].forEach(k => {
      this.quakeGeo.attributes[k].needsUpdate = true;
    });
    this.quakeGeo.setDrawRange(0, 0);
    this.quakeCount = n;
  }

  buildHazardGeometry() {
    const list = this.visibleHazards;
    const geo = this.hazGeo;
    const pos = geo.attributes.position.array;
    const col = geo.attributes.aColor.array;
    const siz = geo.attributes.aSize.array;
    const alp = geo.attributes.aAlpha.array;
    const v = new THREE.Vector3();

    list.forEach((h, i) => {
      llToVec(h.lat, h.lon, MR * 1.004, v);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      const c = HAZ_COLOR[h.type] || [1, 1, 1];
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      siz[i] = 0.07 + Math.min(h.deaths / 40000, 0.09);
      alp[i] = 1;
    });
    ['position', 'aColor', 'aSize', 'aAlpha'].forEach(k => { geo.attributes[k].needsUpdate = true; });
    geo.setDrawRange(0, list.length);
  }

  /* ---------------- главный пересчёт ---------------- */
  refresh(rebuildAll) {
    if (!this.ready && !rebuildAll) return;
    const cat = this.store.catalog();
    if (!cat) return;

    const win = WINDOW_PRESETS.find(w => w.id === this.state.windowId) || WINDOW_PRESETS[2];
    const half = win.days * 43200000;

    if (this.state.mode === MODE_CHRONO) {
      const lo = lb(cat.time, cat.count, this.state.cursor - half);
      const hi = lb(cat.time, cat.count, this.state.cursor + half);
      this.range = { lo, hi };

      if (this.ok) {
        const alp = this.quakeGeo.attributes.aAlpha.array;
        const inv = 1 / half;
        for (let i = lo; i < hi && i < this.quakeCount; i++) {
          const t = Math.abs(cat.time[i] - this.state.cursor) * inv;   // 0 — центр, 1 — край
          alp[i] = this.state.showQuakes ? (1 - smooth(t, 0.72, 1.0)) : 0;
        }
        this.quakeGeo.attributes.aAlpha.needsUpdate = true;
        this.quakeGeo.setDrawRange(lo, Math.min(hi, this.quakeCount));
      }
      this.shownCount = Math.max(0, Math.min(hi, this.quakeCount) - lo);
    } else {
      const hi = lb(cat.time, cat.count, this.state.cursor);
      this.range = { lo: 0, hi: Math.min(hi, this.quakeCount) };

      if (this.ok) {
        // в режиме накопления фильтр по магнитуде применяем один раз
        const alp = this.quakeGeo.attributes.aAlpha.array;
        const mm = this.store.minMag;
        for (let i = 0; i < this.quakeCount; i++) alp[i] = (this.state.showQuakes && cat.mag[i] >= mm) ? 1 : 0;
        this.quakeGeo.attributes.aAlpha.needsUpdate = true;
        this.quakeGeo.setDrawRange(0, Math.min(hi, this.quakeCount));
        this.shownCount = this.quakeGeo.drawRange.count;
      } else {
        this.shownCount = this.range.hi;
      }
    }

    /* катастрофы в окне (или накопленные), с учётом выбранного региона */
    const hazAll = this.store.hazards;
    const box = regionBox(this.store.region);
    const inRegion = (h) => !box ||
      (h.lat >= box.minLat && h.lat <= box.maxLat && h.lon >= box.minLon && h.lon <= box.maxLon);

    if (this.state.mode === MODE_CHRONO) {
      this.visibleHazards = hazAll.filter(h =>
        h.t <= this.state.cursor + half && h.t >= this.state.cursor - half && inRegion(h));
    } else {
      this.visibleHazards = hazAll.filter(h => h.t <= this.state.cursor && inRegion(h));
    }
    if (this.state.showHazards && this.ok) this.buildHazardGeometry();
    else if (this.ok) this.hazGeo.setDrawRange(0, 0);

    this.updateAftershocks();
    this.updateRegionBox();
    this.updateSun();
    this.updateStats();
    this.updateLabels();
  }

  updateAftershocks() {
    if (!this.ok || !this.state.showTrail) {
      if (this.aftGeo) this.aftGeo.setDrawRange(0, 0);
      this.mainIndex = -1;
      return;
    }
    const cat = this.store.catalog();
    const { lo, hi } = this.range;
    if (hi - lo < 2) { this.aftGeo.setDrawRange(0, 0); this.mainIndex = -1; return; }

    const main = this.store.strongest(lo, hi, Math.max(this.store.minMag, 5.0));
    this.mainIndex = main;
    if (main < 0) { this.aftGeo.setDrawRange(0, 0); return; }

    const list = this.store.aftershocks(main, 45, 700).slice(0, this.aftMax);
    const pos = this.aftGeo.attributes.position.array;
    const col = this.aftGeo.attributes.color.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3();
    llToVec(cat.lat[main], cat.lon[main], MR * 1.004, a);
    const c0 = magColor(cat.mag[main]);
    const steps = this.aftSteps;

    list.forEach((idx, k) => {
      llToVec(cat.lat[idx], cat.lon[idx], MR * 1.004, b);
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        slerpVec(a, b, t0, MR * 1.004, p);
        const o = (k * steps + s) * 6;
        pos.set([p.x, p.y, p.z], o);
        pos.set([p.x, p.y, p.z], o + 3);
        const f = 0.35 + 0.65 * t0;
        col.set([c0[0] * f, c0[1] * f, c0[2] * f], o);
        col.set([c0[0] * f, c0[1] * f, c0[2] * f], o + 3);
      }
    });
    this.aftGeo.attributes.position.needsUpdate = true;
    this.aftGeo.attributes.color.needsUpdate = true;
    this.aftGeo.setDrawRange(0, list.length * steps * 2);
  }

  updateRegionBox() {
    if (!this.ok) return;
    const box = regionBox(this.store.region);
    const geo = this.regionBox.geometry;
    // при выборе региона слегка приглушаем остальную планету — регион становится главным
    this.earthMat.uniforms.dim.value = box ? 0.45 : 0;
    if (!box) { geo.setDrawRange(0, 0); return; }

    const r = R * 1.006, SEG = 20;
    const arr = geo.attributes.position.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    let n = 0;
    const push = (la1, lo1, la2, lo2) => {
      if (n + 2 > arr.length / 3) return;
      llToVec(la1, lo1, r, a); llToVec(la2, lo2, r, b);
      arr.set([a.x, a.y, a.z, b.x, b.y, b.z], n * 3);
      n += 2;
    };
    const dLat = box.maxLat - box.minLat, dLon = box.maxLon - box.minLon;
    for (let i = 0; i < SEG; i++) {
      const t0 = i / SEG, t1 = (i + 1) / SEG;
      push(box.minLat, box.minLon + dLon * t0, box.minLat, box.minLon + dLon * t1); // юг
      push(box.maxLat, box.minLon + dLon * t0, box.maxLat, box.minLon + dLon * t1); // север
      push(box.minLat + dLat * t0, box.minLon, box.minLat + dLat * t1, box.minLon); // запад
      push(box.minLat + dLat * t0, box.maxLon, box.minLat + dLat * t1, box.maxLon); // восток
    }
    geo.attributes.position.needsUpdate = true;
    geo.setDrawRange(0, n);
  }

  updateSun() {
    if (!this.ok) return;
    const d = sunDirectionFor(this.state.cursor, new THREE.Vector3());
    this.earthMat.uniforms.sunDir.value.copy(d);
    this.atmo.material.uniforms.sunDir.value.copy(d);
  }

  /* ---------------- статистика и подписи ---------------- */
  updateStats() {
    const cat = this.store.catalog();
    const win = WINDOW_PRESETS.find(w => w.id === this.state.windowId) || WINDOW_PRESETS[2];
    const { lo, hi } = this.range;

    // сколько реально видно с учётом фильтра магнитуды
    let visible = 0, strongest = -1, bestMag = -Infinity;
    for (let i = lo; i < hi; i++) {
      if (cat.mag[i] >= this.store.minMag) {
        visible++;
        if (cat.mag[i] > bestMag) { bestMag = cat.mag[i]; strongest = i; }
      }
    }
    const haz = this.visibleHazards.length;
    const deaths = this.visibleHazards.reduce((s, h) => s + (h.deaths || 0), 0);

    $('#stCount').textContent = fmtInt(visible);
    $('#stMax').textContent = strongest >= 0 ? bestMag.toFixed(1) : '—';
    $('#stWhere').textContent = strongest >= 0 ? (cat.place[strongest] || '—') : '—';
    $('#stHaz').textContent = haz ? fmtInt(haz) : '—';
    $('#stDeaths').textContent = haz ? (deaths ? fmtInt(deaths) : '—') : '—';
    $('#timeLabel').textContent = fmtDate(this.state.cursor);
    $('#windowLabel').textContent = this.state.mode === MODE_CHRONO
      ? 'окно ±' + win.label.toLowerCase()
      : 'всё с 1950 г.';
  }

  updateLabels() {
    if (!this.labelLayer) return;
    if (!this.state.showLabels) { this.labelLayer.innerHTML = ''; return; }
    const cat = this.store.catalog();
    const { lo, hi } = this.range;
    const top = this.store.topIn(lo, hi, Math.max(this.store.minMag, this.modeMin()), 8);
    this.labelIdx = top;
    this.renderLabels();
  }

  modeMin() {
    const win = WINDOW_PRESETS.find(w => w.id === this.state.windowId) || WINDOW_PRESETS[2];
    if (this.state.mode === MODE_CUMUL) return Math.max(this.store.minMag, 6.0);
    if (win.days <= 7) return this.store.minMag;
    if (win.days <= 92) return this.store.minMag + 0.5;
    return this.store.minMag + 1.5;
  }

  renderLabels() {
    if (!this.labelLayer || !this.ok || !this.state.showLabels) {
      if (this.labelLayer) this.labelLayer.innerHTML = '';
      return;
    }
    const cat = this.store.catalog();
    const idx = this.labelIdx || [];
    const cam = this.camera;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    cam.getWorldDirection(camDir);
    let html = '';
    for (const i of idx.slice(0, 8)) {
      llToVec(cat.lat[i], cat.lon[i], MR, v);
      const facing = v.clone().normalize().dot(camDir) > 0.08;
      if (!facing) continue;
      v.project(cam);
      if (v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * rect.width;
      const y = (-v.y * 0.5 + 0.5) * rect.height;
      if (x < 40 || x > rect.width - 40 || y < 30 || y > rect.height - 30) continue;
      html += `<div class="gmap-label" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px">` +
              `M${cat.mag[i].toFixed(1)}</div>`;
    }
    this.labelLayer.innerHTML = html;
  }

  /* ---------------- мышь ---------------- */
  bindMouse(el) {
    if (!el) return;
    this.mouseEl = el;
    el.style.touchAction = 'none';
    this.drag = { on: false, x: 0, y: 0, moved: 0 };

    el.addEventListener('pointerdown', e => {
      this.drag.on = true; this.drag.x = e.clientX; this.drag.y = e.clientY; this.drag.moved = 0;
      this.autoRotate = false;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (this.drag.on) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        this.cam.tLon -= dx * 0.32;
        this.cam.tLat = clamp(this.cam.tLat + dy * 0.32, -84, 84);
        this.cam.lon = this.cam.tLon; this.cam.lat = this.cam.tLat;
        this.drag.x = e.clientX; this.drag.y = e.clientY;
      } else {
        this.queueHover(e);
      }
    });
    const end = e => {
      if (!this.drag.on) return;
      this.drag.on = false;
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
      if (this.drag.moved < 6) this.handleClick(e);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { this.hoverIndex = -1; this.hideTip(); });

    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.cam.tDist = clamp(this.cam.tDist * (1 + Math.sign(e.deltaY) * 0.09), 3.4, 20);
    }, { passive: false });
  }

  queueHover(e) {
    if (this._hoverPending) return;
    this._hoverPending = true;
    setTimeout(() => {
      this._hoverPending = false;
      this.handleHover(e);
    }, 45);
  }

  screenToIndex(px, py) {
    const cat = this.store.catalog();
    if (!cat) return -1;
    if (!this.ok) return this.screenToIndex2D(px, py);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = px - rect.left, my = py - rect.top;
    const { lo, hi } = this.range;
    const v = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    let best = -1, bestD = 18 * 18;
    const stride = (hi - lo) > 12000 ? Math.ceil((hi - lo) / 12000) : 1;
    for (let i = lo; i < hi; i += stride) {
      if (cat.mag[i] < this.store.minMag) continue;
      llToVec(cat.lat[i], cat.lon[i], MR, v);
      if (v.clone().normalize().dot(camDir) <= 0.05) continue;
      v.project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      const d = (sx - mx) * (sx - mx) + (sy - my) * (sy - my);
      if (d < bestD) { bestD = d; best = i; }
    }
    // катастрофы
    const hv = new THREE.Vector3();
    for (let k = 0; k < this.visibleHazards.length; k++) {
      const h = this.visibleHazards[k];
      llToVec(h.lat, h.lon, MR * 1.004, hv);
      if (hv.clone().normalize().dot(camDir) <= 0.05) continue;
      hv.project(this.camera);
      const sx = (hv.x * 0.5 + 0.5) * rect.width;
      const sy = (-hv.y * 0.5 + 0.5) * rect.height;
      const d = (sx - mx) * (sx - mx) + (sy - my) * (sy - my);
      if (d < bestD) { bestD = d; best = -2 - k; }
    }
    return best;
  }

  /** Выбор точки на плоской карте (когда WebGL недоступен). */
  screenToIndex2D(px, py) {
    const cat = this.store.catalog();
    if (!cat || !this.c2d) return -1;
    const rect = this.c2d.getBoundingClientRect();
    const mx = px - rect.left, my = py - rect.top;
    const { lo, hi } = this.range || { lo: 0, hi: 0 };
    const X = lon => (lon + 180) / 360 * rect.width;
    const Y = lat => (90 - lat) / 180 * rect.height;
    let best = -1, bestD = 16 * 16;
    for (let i = lo; i < hi; i++) {
      if (cat.mag[i] < this.store.minMag) continue;
      const dx = X(cat.lon[i]) - mx, dy = Y(cat.lat[i]) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    for (let k = 0; k < this.visibleHazards.length; k++) {
      const h = this.visibleHazards[k];
      const dx = X(h.lon) - mx, dy = Y(h.lat) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = -2 - k; }
    }
    return best;
  }

  handleHover(e) {
    const idx = this.screenToIndex(e.clientX, e.clientY);
    if (idx === this.hoverIndex) return;
    this.hoverIndex = idx;
    if (idx === -1) { this.hideTip(); return; }
    const tip = $('#globeTip');
    if (!tip) return;
    const cat = this.store.catalog();
    let html;
    if (idx <= -2) {
      const h = this.visibleHazards[-2 - idx];
      html = `<b>${h.name}</b><span>${HAZ_TITLE[h.type] || h.type} · ${fmtDate(h.t)}</span>`;
    } else {
      html = `<b>M ${cat.mag[idx].toFixed(1)}</b><span>${cat.place[idx] || ''}</span>`;
    }
    tip.innerHTML = html;
    const el = this.renderer ? this.renderer.domElement : this.c2d;
    const rect = el.getBoundingClientRect();
    tip.style.left = (e.clientX - rect.left + 14) + 'px';
    tip.style.top = (e.clientY - rect.top + 14) + 'px';
    tip.classList.add('is-on');
  }

  hideTip() {
    const t = $('#globeTip');
    if (t) t.classList.remove('is-on');
  }

  handleClick(e) {
    const idx = this.screenToIndex(e.clientX, e.clientY);
    if (idx === -1) { $('#infoBox').classList.remove('is-on'); return; }
    if (idx <= -2) {
      this.showHazardInfo(this.visibleHazards[-2 - idx]);
    } else {
      this.showQuakeInfo(idx);
    }
    this.info = { kind: idx <= -2 ? 'haz' : 'quake', i: idx };
  }

  showQuakeInfo(i) {
    const c = this.store.catalog();
    const d = new Date(c.time[i]);
    const main = this.mainIndex === i ? this.store.aftershocks(i, 45, 700).length : 0;
    $('#infoTitle').textContent = 'M ' + c.mag[i].toFixed(1);
    $('#infoSub').textContent = fmtDate(c.time[i], true) + ' UTC';
    $('#infoBody').innerHTML =
      `<b>Где:</b> ${c.place[i] || '—'}<br>` +
      `<b>Глубина:</b> ${c.dep[i]} км<br>` +
      `<b>Координаты:</b> ${c.lat[i].toFixed(2)}° с.ш., ${c.lon[i].toFixed(2)}° в.д.<br>` +
      (main ? `<b>Афтершоков за 45 сут:</b> ${main}<br>` : '') +
      `<span class="small">Источник: USGS Earthquake Hazards Program. Слева внизу — кнопка «показать окрестности».</span>`;
    const btn = $('#infoFocus');
    if (btn) btn.style.display = 'inline-flex';
    $('#infoBox').classList.add('is-on');
  }

  showHazardInfo(h) {
    $('#infoTitle').textContent = h.name;
    $('#infoSub').textContent = fmtDate(h.t);
    $('#infoBody').innerHTML =
      `<b>Тип:</b> ${HAZ_TITLE[h.type] || h.type}<br>` +
      `<b>Погибло:</b> ${h.deaths ? fmtInt(h.deaths) + ' чел.' : 'нет данных'}<br>` +
      `<b>Координаты:</b> ${h.lat}°, ${h.lon}°<br><br>` +
      `<span>${h.text}</span>`;
    const btn = $('#infoFocus');
    if (btn) btn.style.display = 'none';
    $('#infoBox').classList.add('is-on');
  }

  /* ---------------- камера ---------------- */
  flyTo(lat, lon, dist) {
    this.cam.tLat = clamp(lat, -84, 84);
    this.cam.tLon = lon;
    if (dist) this.cam.tDist = clamp(dist, 3.4, 20);
    this.autoRotate = false;
    this.flyAnim = {
      from: { lat: this.cam.lat, lon: this.cam.lon, dist: this.cam.dist },
      to:   { lat: this.cam.tLat,  lon: this.cam.tLon,  dist: this.cam.tDist },
      t: 0
    };
  }

  /** Стартовое положение: всегда показываем освещённую сторону планеты. */
  viewToSunlitSide() {
    const sun = sunDirectionFor(this.state.cursor, new THREE.Vector3());
    // камера ставится по формуле (cosφ·sinλ, sinφ, cosφ·cosλ) — отсюда λ = atan2(x, z)
    const lat = Math.asin(clamp(sun.y, -1, 1)) / DEG;
    const lon = Math.atan2(sun.x, sun.z) / DEG;
    return { lat: clamp(lat * 0.7, -55, 55), lon: lon + 18 };
  }

  resetView() {
    const v = this.viewToSunlitSide();
    this.flyTo(v.lat, v.lon, 7.0);
  }

  applyCamera(dt) {
    if (!this.ok) return;
    const c = this.cam;
    const fa = this.flyAnim;
    if (fa) {
      // анимация по времени, а не по кадрам: на слабом компьютере подлёт тоже займёт ~0.9 с
      fa.t = Math.min(1, fa.t + dt / 0.9);
      const t = 1 - Math.pow(1 - fa.t, 3);
      let dLon = fa.to.lon - fa.from.lon;
      while (dLon > 180) dLon -= 360;
      while (dLon < -180) dLon += 360;
      c.lat  = fa.from.lat + (fa.to.lat  - fa.from.lat) * t;
      c.lon  = fa.from.lon + dLon * t;
      c.dist = fa.from.dist + (fa.to.dist - fa.from.dist) * t;
      if (fa.t >= 1) this.flyAnim = null;
    } else {
      c.lat  += (c.tLat  - c.lat)  * 0.18;
      c.lon  += (c.tLon  - c.lon)  * 0.18;
      c.dist += (c.tDist - c.dist) * 0.18;
    }
    if (this.autoRotate) c.tLon += 0.25;

    const la = c.lat * DEG, lo = c.lon * DEG;
    this.camera.position.set(
      c.dist * Math.cos(la) * Math.sin(lo),
      c.dist * Math.sin(la),
      c.dist * Math.cos(la) * Math.cos(lo)
    );
    this.camera.lookAt(0, 0, 0);
  }

  resize() {
    const stage = $('#globeStage');
    if (!stage) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    if (this.ok) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    } else if (this.ctx2d) {
      const dpr = Math.min(devicePixelRatio, 2);
      this.c2d.width = w * dpr; this.c2d.height = h * dpr;
    }
    this.drawFallbackImage();
  }

  drawFallbackImage() {
    if (this.ok || !this.c2d) return;
    if (this.dayImg) return;
    const img = new Image();
    img.onload = () => { this.dayImg = img; this.draw2D(); };
    img.src = 'assets/img/earth_day.jpg';
  }

  /* ---------------- цикл ---------------- */
  loop(now) {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;

    if (this.state.playing) {
      const b = this.store.bounds();
      const span = b ? (b.to - b.from) : 0;
      const win = WINDOW_PRESETS.find(w => w.id === this.state.windowId) || WINDOW_PRESETS[2];
      // скорость — «дней в секунду реального времени»
      const perSec = this.state.speed * (win.days / 24);
      this.state.cursor += perSec * 86400000 * dt;
      if (this.state.cursor >= b.to) { this.state.cursor = b.to; this.pause(); }
      this.syncSlider();
      this.refresh();
    }

    if (!this.ok) { this.draw2D(); return; }

    this.applyCamera(dt);
    this.renderLabels();

    // анимация кольца ударной волны у только что выбранного события
    if (this.waveLine.visible) {
      this.waveT = (this.waveT || 0) + dt * 0.34;
      if (this.waveT >= 3) { this.waveLine.visible = false; this.waveMat.opacity = 0; }
      else {
        const phase = this.waveT % 1;
        const s = 0.05 + phase * 0.42;
        this.waveLine.scale.set(s, s, s);
        this.waveMat.opacity = (1 - phase) * 0.85;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  triggerWave(i) {
    if (!this.ok || i < 0) return;
    const c = this.store.catalog();
    const dir = llToVec(c.lat[i], c.lon[i], 1, new THREE.Vector3());
    const obj = new THREE.Object3D();
    obj.position.copy(dir);
    obj.lookAt(dir.clone().multiplyScalar(2));
    this.waveLine.position.copy(dir.clone().multiplyScalar(MR * 1.002));
    this.waveLine.quaternion.copy(obj.quaternion);
    this.waveT = 0;
    this.waveLine.visible = true;
  }

  setStatus(s) { const e = $('#globeStatus'); if (e) e.textContent = s; }

  /* ---------------- интерфейс ---------------- */
  setSliderBounds(b) {
    const t = $('#timeRange');
    t.min = Math.floor(b.from / 86400000) * 86400000;
    t.max = Math.ceil(b.to / 86400000) * 86400000;
    t.step = 3600000;                    // час — чтобы курсор не «уезжал» на сутки
    t.value = this.state.cursor;
  }

  syncSlider() {
    const t = $('#timeRange');
    if (Math.abs(+t.value - this.state.cursor) > 3600000) t.value = this.state.cursor;
    const d = $('#dateInput');
    // дата всегда считается по UTC — так курсор, ползунок и поле показывают одно и то же
    const iso = new Date(this.state.cursor).toISOString().slice(0, 10);
    if (d.value !== iso) d.value = iso;
  }

  play() {
    const b = this.store.bounds();
    if (!b) return;
    if (this.state.cursor >= b.to - 86400000) this.state.cursor = b.from;
    this.state.playing = true;
    this.updatePlayBtn();
  }
  pause() { this.state.playing = false; this.updatePlayBtn(); }
  togglePlay() { this.state.playing ? this.pause() : this.play(); }
  updatePlayBtn() {
    const b = $('#playBtn');
    if (b) { b.textContent = this.state.playing ? '⏸ Пауза' : '▶ Играть'; b.classList.toggle('is-on', this.state.playing); }
  }

  bindUI() {
    /* режим времени */
    const MODE_HELP = {
      chrono: 'Видно события <b>вокруг</b> выбранной даты — так видно, что происходило именно тогда. Нажми «Играть», чтобы оживить хронику.',
      cumulative: 'Видно <b>всё, что произошло до</b> выбранной даты. Отлично, чтобы сравнить: сколько бедствий накопилось к году.'
    };
    $$('#modeRow .mode-btn').forEach(b => b.addEventListener('click', () => {
      $$('#modeRow .mode-btn').forEach(x => x.classList.toggle('is-on', x === b));
      this.state.mode = b.dataset.mode;
      $('#modeHelp').innerHTML = MODE_HELP[this.state.mode];
      this.refresh();
    }));

    /* окно времени */
    $$('#winRow .win-btn').forEach(b => b.addEventListener('click', () => {
      $$('#winRow .win-btn').forEach(x => x.classList.toggle('is-on', x === b));
      this.state.windowId = b.dataset.win;
      this.refresh();
    }));

    /* скорость */
    $$('#speedRow .sp-btn').forEach(b => b.addEventListener('click', () => {
      $$('#speedRow .sp-btn').forEach(x => x.classList.toggle('is-on', x === b));
      this.state.speed = +b.dataset.sp;
    }));

    /* регион */
    $$('#regionRow .region-btn').forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.region === this.store.region) return;
      await this.setRegion(b.dataset.region);
    }));

    /* слои */
    const layerMap = { layQuakes: 'showQuakes', layHazards: 'showHazards', layGrid: 'showGrid', layLabels: 'showLabels', layTrail: 'showTrail' };
    Object.entries(layerMap).forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => {
        this.state[key] = el.checked;
        if (key === 'showGrid' && this.ok) this.grid.visible = el.checked;
        this.refresh();
      });
    });

    /* фильтр магнитуды */
    const mr = $('#magRange');
    if (mr) mr.addEventListener('input', () => {
      this.store.state.minMag = +mr.value;
      $('#magLabel').textContent = 'M ≥ ' + (+mr.value).toFixed(1);
      this.refresh();
    });

    /* таймлайн */
    const t = $('#timeRange');
    t.addEventListener('input', () => {
      this.state.cursor = +t.value;
      this.pause();
      this.refresh();
      this.syncSlider();
    });

    $('#dateInput').addEventListener('change', () => this.applyDateInput());
    $('#goDate').addEventListener('click', () => this.applyDateInput());

    $('#playBtn').addEventListener('click', () => this.togglePlay());
    $('#resetView').addEventListener('click', () => this.resetView());

    $('#infoClose').addEventListener('click', () => $('#infoBox').classList.remove('is-on'));
    $('#infoFocus').addEventListener('click', () => {
      if (this.info.kind !== 'quake') return;
      const c = this.store.catalog();
      const i = this.info.i;
      this.flyTo(c.lat[i], c.lon[i], 4.3);
      this.state.windowId = 'month';
      $$('#winRow .win-btn').forEach(x => x.classList.toggle('is-on', x.dataset.win === 'month'));
      this.state.cursor = c.time[i];
      this.state.mode = MODE_CHRONO;
      $$('#modeRow .mode-btn').forEach(x => x.classList.toggle('is-on', x.dataset.mode === MODE_CHRONO));
      this.pause();
      this.syncSlider();
      this.refresh();
      this.triggerWave(i);
    });

    /* катастрофы из списка */
    $$('#hazList .haz-row').forEach(row => row.addEventListener('click', () => {
      const h = this.store.hazards.find(x => x.id === row.dataset.id);
      if (!h) return;
      this.gotoHazard(h);
    }));

    /* горячие клавиши карты (стрелки оставлены для перелистывания слайдов) */
    document.addEventListener('keydown', e => {
      const slide = document.querySelector('.globe-slide');
      if (!slide || !slide.classList.contains('is-active')) return;
      if (e.target.matches('input, select, textarea')) return;
      const k = e.key;
      if (k === ' ' || k === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.togglePlay();
      } else if (k === ',' || k === 'ж') {
        e.preventDefault(); this.step(-1);
      } else if (k === '.' || k === 'ю') {
        e.preventDefault(); this.step(1);
      } else if (k === '[') {
        e.preventDefault(); this.cycleWindow(-1);
      } else if (k === ']') {
        e.preventDefault(); this.cycleWindow(1);
      }
    }, true);
  }

  step(dir) {
    const win = WINDOW_PRESETS.find(w => w.id === this.state.windowId) || WINDOW_PRESETS[2];
    this.state.cursor += dir * win.days * 86400000;
    this.pause();
    this.refresh();
    this.syncSlider();
  }

  /** Переключение размера окна клавишами [ и ] */
  cycleWindow(dir) {
    const i = WINDOW_PRESETS.findIndex(w => w.id === this.state.windowId);
    const j = clamp(i + dir, 0, WINDOW_PRESETS.length - 1);
    const w = WINDOW_PRESETS[j];
    this.state.windowId = w.id;
    $$('#winRow .win-btn').forEach(x => x.classList.toggle('is-on', x.dataset.win === w.id));
    this.refresh();
    this.setStatus('Окно показа: ' + w.label);
  }

  applyDateInput() {
    const v = $('#dateInput').value;
    if (!v) return;
    const ms = Date.parse(v + 'T12:00:00Z');
    const b = this.store.bounds();
    if (!b) return;
    if (ms < b.from) {
      this.state.cursor = b.from;
      this.setStatus('Каталог начинается с ' + fmtDate(b.from) + ' — показываю первую доступную дату');
    } else if (ms > b.to) {
      this.state.cursor = b.to;
      this.setStatus('Каталог заканчивается на ' + fmtDate(b.to) + ' — показываю последнюю доступную дату');
    } else {
      this.state.cursor = ms;
      this.setStatus('Показана дата ' + fmtDate(ms));
    }
    this.pause();
    this.syncSlider();
    this.refresh();
    this.autoFlyToStrongest();
  }

  /** Если в окне есть крупное событие — подлетаем к нему, иначе дата покажется «пустой». */
  autoFlyToStrongest() {
    if (this.state.mode !== MODE_CHRONO || !this.store.catalog()) return;
    const cat = this.store.catalog();
    const { lo, hi } = this.range;
    const i = this.store.strongest(lo, hi, this.store.minMag);
    if (i < 0 || cat.mag[i] < 6.0) return;
    this.flyTo(cat.lat[i], cat.lon[i] + 90, Math.min(Math.max(this.cam.tDist, 4.8), 5.4));
    this.triggerWave(i);
  }

  async setRegion(region) {
    const box = regionBox(region);
    if (box) {
      const lat = (box.minLat + box.maxLat) / 2;
      const lon = (box.minLon + box.maxLon) / 2;
      this.flyTo(lat, lon + 90, 5.8);
    }
    this.setStatus('Загружаю каталог: ' + region + '…');
    try {
      await this.store.loadRegion(region, p => this.setStatus('Каталог: ' + Math.round(p * 100) + '%'));
      if (this.ok) this.buildQuakeGeometry();
      const b = this.store.bounds();
      this.state.cursor = b.to;
      this.setSliderBounds(b);
      this.syncSlider();
      const sl = $('#magRange');
      sl.value = String(this.store.minMag);
      $('#magLabel').textContent = 'M ≥ ' + this.store.minMag.toFixed(1);
      $$('#regionRow .region-btn').forEach(x => x.classList.toggle('is-on', x.dataset.region === region));
      this.refresh();
      const c = this.store.catalog();
      // окно подбираем под регион: для спокойных областей — вся история, для крупных — месяц
      const wantWin = c.count < 120 ? 'all' : 'month';
      this.state.windowId = wantWin;
      $$('#winRow .win-btn').forEach(x => x.classList.toggle('is-on', x.dataset.win === wantWin));
      this.refresh();
      this.setStatus(this.store.source.label + ': ' + fmtInt(c.count) + ' событий, ' +
        fmtDate(b.from) + ' — ' + fmtDate(b.to) +
        (wantWin === 'all' ? ' · показана вся история региона' : ''));
      this.renderHazardList();
    } catch (e) {
      this.setStatus('Ошибка: ' + e.message);
    }
  }

  renderHazardList() {
    const box = regionBox(this.store.region);
    const list = this.store.hazards;
    const host = $('#hazList');
    if (!host) return;
    const rows = list.filter(h => !box || (h.lat >= box.minLat && h.lat <= box.maxLat && h.lon >= box.minLon && h.lon <= box.maxLon));
    const shown = rows.length ? rows : list.slice(0, 8);
    host.innerHTML = shown.map(h => {
      const c = HAZ_COLOR[h.type] || [1, 1, 1];
      const rgb = c.map(x => Math.round(x * 255)).join(',');
      return `<button class="haz-row" data-id="${h.id}">` +
             `<i class="haz-dot" style="background:rgb(${rgb})"></i>` +
             `<span>${h.name}</span><span class="haz-yr">${new Date(h.t).getFullYear()}</span></button>`;
    }).join('');
    host.querySelectorAll('.haz-row').forEach(r => r.addEventListener('click', () => {
      const h = this.store.hazards.find(x => x.id === r.dataset.id);
      if (h) this.gotoHazard(h);
    }));
  }

  gotoHazard(h) {
    // при необходимости переключаем регион, чтобы катастрофа была в кадре
    const need = this.regionForHazard(h);
    const run = async () => {
      this.state.windowId = 'month';
      $$('#winRow .win-btn').forEach(x => x.classList.toggle('is-on', x.dataset.win === 'month'));
      this.state.mode = MODE_CHRONO;
      $$('#modeRow .mode-btn').forEach(x => x.classList.toggle('is-on', x.dataset.mode === MODE_CHRONO));
      this.state.cursor = h.t;
      this.pause();
      this.syncSlider();
      this.flyTo(h.lat, h.lon + 90, 4.6);
      this.refresh();
      this.showHazardInfo(h);
      this.setStatus(HAZ_TITLE[h.type] + ': ' + h.name + ' — ' + fmtDate(h.t));
    };
    if (need && need !== this.store.region) {
      this.setRegion(need).then(run);
    } else run();
  }

  regionForHazard(h) {
    if (h.lat >= 48 && h.lat <= 56.5 && h.lon >= 50 && h.lon <= 62.5) return 'orenburg';
    if (h.lat >= 41 && h.lat <= 82 && h.lon >= 19 && h.lon <= 190) return 'russia';
    return 'world';
  }
}

/* утилиты */
function lb(arr, n, t) {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; }
  return lo;
}
function smooth(x, a, b) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ============================================================
   Публичный API
   ============================================================ */
let app = null;

export function initGlobe() {
  if (app) return;
  const slide = document.querySelector('.globe-slide');
  if (!slide) return;
  app = new GlobeApp();
  app.init();
  slide.dataset.globeReady = '1';
}

export function setGlobeActive(on) {
  if (!app) return;
  if (on) {
    if (document.querySelector('.globe-slide').dataset.globeReady !== '1') initGlobe();
    app.lastT = performance.now();
    if (app.store.bounds()) app.refresh();
  }
}

window.globeAPI = {
  ensure() { initGlobe(); },
  active() {},
  reset() { if (app) app.resetView(); },
  ready() { return !!app; },
  app() { return app; }
};