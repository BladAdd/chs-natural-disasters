/* ============================================================
   DataStore — каталоги ЧС с быстрым поиском по времени
   Данные лежат в типизированных массивах: пересчёт кадра O(1)
   ============================================================ */

/** Разбор CSV-каталога без создания миллиона временных строк. */
function parseCatalog(text, onProgress) {
  const n = text.length;

  // 1) Считаем количество строк данных
  let lines = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
  lines = Math.max(0, lines - 1);

  const time = new Float64Array(lines);
  const lat  = new Float32Array(lines);
  const lon  = new Float32Array(lines);
  const mag  = new Float32Array(lines);
  const dep  = new Float32Array(lines);
  const place = new Array(lines);

  // 2) Заполняем
  let row = 0, pos = text.indexOf('\n') + 1;
  for (; pos < n && row < lines; ) {
    let e = text.indexOf(';', pos);   if (e === -1) break;
    time[row] = +text.slice(pos, e);

    let s = e + 1; e = text.indexOf(';', s); lat[row] = +text.slice(s, e);

    s = e + 1; e = text.indexOf(';', s); lon[row] = +text.slice(s, e);

    s = e + 1; e = text.indexOf(';', s); mag[row] = +text.slice(s, e);

    s = e + 1; e = text.indexOf(';', s); dep[row] = +text.slice(s, e);

    s = e + 1;
    let nl = text.indexOf('\n', s);
    if (nl === -1) nl = n;
    place[row] = text.slice(s, nl);

    pos = nl + 1;
    row++;
    if (onProgress && (row & 8191) === 0) onProgress(row / lines);
  }

  // 3) Отсекаем хвост (если файл оборвался)
  return {
    count: row,
    time, lat, lon, mag, dep, place
  };
}

/** Индекс первого события с временем >= t (события отсортированы). */
export function lowerBound(time, count, t) {
  let lo = 0, hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const SOURCES = {
  world:    { file: 'assets/data/quakes-world.csv',    label: 'Весь мир',            minMag: 5.0 },
  russia:   { file: 'assets/data/quakes-russia.csv',   label: 'Россия',              minMag: 3.5 },
  orenburg: { file: 'assets/data/quakes-orenburg.csv', label: 'Оренбургская обл.',  minMag: 2.0 }
};

export class DataStore {
  constructor() {
    this.catalogs = {};      // region -> {count,time,lat,lon,mag,dep,place}
    this.hazards = [];
    this.hazardTimes = new Float64Array(0);
    this.state = { region: 'world', minMag: SOURCES.world.minMag, loading: null, progress: 0 };
  }

  get region() { return this.state.region; }
  get minMag() { return this.state.minMag; }
  get source() { return SOURCES[this.state.region]; }

  catalog() { return this.catalogs[this.state.region] || null; }

  /** Первая и последняя дата в каталоге региона. */
  bounds() {
    const c = this.catalog();
    if (!c || !c.count) return null;
    return { from: c.time[0], to: c.time[c.count - 1] };
  }

  async loadRegion(region, onProgress) {
    if (this.state.loading === region && this.catalog()) return this.catalog();
    const src = SOURCES[region];
    if (!src) throw new Error('Неизвестный регион: ' + region);

    this.state.loading = region;
    this.state.progress = 0;

    const res = await fetch(src.file);
    if (!res.ok) throw new Error('Не удалось загрузить ' + src.file);

    const text = await res.text();
    const cat = parseCatalog(text, p => { this.state.progress = p; onProgress && onProgress(p); });

    cat.maxMag = 0;
    for (let i = 0; i < cat.count; i++) if (cat.mag[i] > cat.maxMag) cat.maxMag = cat.mag[i];

    this.catalogs[region] = cat;
    this.state.region = region;
    this.state.minMag = src.minMag;
    this.state.loading = null;
    return cat;
  }

  async loadHazards() {
    if (this.hazards.length) return this.hazards;
    const res = await fetch('assets/data/hazards.json');
    const j = await res.json();
    this.hazards = (j.events || []).map(e => ({
      ...e, t: Date.parse(e.date)
    })).sort((a, b) => a.t - b.t);
    this.hazardTimes = new Float64Array(this.hazards.length);
    this.hazards.forEach((e, i) => { this.hazardTimes[i] = e.t; });
    return this.hazards;
  }

  /** Индексы событий [lo, hi) в окне времени вокруг cursor. */
  windowRange(cursor, halfWidth, minMag) {
    const c = this.catalog();
    if (!c) return { lo: 0, hi: 0 };
    const lo = lowerBound(c.time, c.count, cursor - halfWidth);
    const hi = lowerBound(c.time, c.count, cursor + halfWidth);
    return { lo, hi };
  }

  /** Кол-во событий от начала каталога до cursor включительно. */
  cumulativeCount(cursor, minMag) {
    const c = this.catalog();
    if (!c) return 0;
    let hi = lowerBound(c.time, c.count, cursor);
    // при желании — по магнитуде, но дешевле один раз отфильтровать
    return hi;
  }

  /** Самое сильное событие в диапазоне индексов. */
  strongest(lo, hi, minMag) {
    const c = this.catalog();
    let best = -1, bestMag = -Infinity;
    for (let i = lo; i < hi; i++) {
      if (c.mag[i] >= minMag && c.mag[i] > bestMag) { bestMag = c.mag[i]; best = i; }
    }
    return best;
  }

  /** Главные события в окне — для подписей на карте. */
  topIn(lo, hi, minMag, limit) {
    const c = this.catalog();
    const out = [];
    for (let i = lo; i < hi; i++) {
      if (c.mag[i] >= minMag) out.push(i);
    }
    out.sort((a, b) => c.mag[b] - c.mag[a]);
    return out.slice(0, limit);
  }

  /** Афтершоки: события рядом по времени и расстоянию с главным толчком. */
  aftershocks(mainIndex, maxDays, maxKm) {
    const c = this.catalog();
    const t0 = c.time[mainIndex];
    const la0 = c.lat[mainIndex], lo0 = c.lon[mainIndex];
    const out = [];
    for (let i = mainIndex + 1; i < c.count; i++) {
      const dt = (c.time[i] - t0) / 86400000;
      if (dt > maxDays) break;
      if (dt <= 0) continue;
      if (c.mag[i] < Math.max(2.5, c.mag[mainIndex] - 3.2)) continue;
      const d = haversineKm(la0, lo0, c.lat[i], c.lon[i]);
      if (d > maxKm) continue;
      out.push(i);
      if (out.length >= 120) break;
    }
    return out;
  }

  /** Катастрофы, попадающие в окно времени (для текущего региона). */
  hazardsIn(cursor, halfWidth, regionName) {
    const out = [];
    for (const h of this.hazards) {
      if (h.t > cursor + halfWidth) break;
      if (h.t < cursor - halfWidth) continue;
      if (regionName && !hazardMatchesRegion(h, regionName)) continue;
      out.push(h);
    }
    return out;
  }
}

const REGION_BOX = {
  russia:   { minLat: 41, maxLat: 82, minLon: 19, maxLon: 190, label: 'Россия' },
  orenburg: { minLat: 48, maxLat: 56.5, minLon: 50, maxLon: 62.5, label: 'Оренбургская обл.' },
  world:    null
};

export function regionBox(region) { return REGION_BOX[region] || null; }

/** Грубая привязка легендарной катастрофы к региону. */
function hazardMatchesRegion(h, region) {
  const box = REGION_BOX[region];
  if (!box) return true;
  return h.lat >= box.minLat && h.lat <= box.maxLat && h.lon >= box.minLon && h.lon <= box.maxLon;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const Rk = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * Rk * Math.asin(Math.sqrt(a));
}

export const WINDOW_PRESETS = [
  { id: 'day',    label: 'Сутки',  days: 1 },
  { id: 'week',   label: 'Неделя', days: 7 },
  { id: 'month',  label: 'Месяц',  days: 30 },
  { id: 'quarter',label: '3 мес.',  days: 92 },
  { id: 'year',   label: 'Год',    days: 365 },
  { id: 'decade', label: '10 лет', days: 3652 },
  { id: 'all',    label: 'Всё',    days: 36500 }
];

export const SPEED_PRESETS = [
  { v: 1,    label: '1 ч/с' },
  { v: 6,    label: '6 ч/с' },
  { v: 24,   label: '1 сут/с' },
  { v: 168,  label: '1 нед/с' },
  { v: 720,  label: '1 мес/с' },
  { v: 4380, label: '1 год/с' }
];