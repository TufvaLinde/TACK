import fs from "node:fs";
import path from "node:path";
import type { PointWeather, WeatherGridMeta, WeatherStatus } from "../../shared/types.js";
import { config } from "../config.js";
import { netFetch, OfflineError } from "../net.js";

// Weather provider interface: anything that can deliver a gridded hourly forecast.
export interface WeatherProvider {
  name: string;
  fetchGrid(bbox: BBox): Promise<WeatherGrid>;
}

export interface BBox { south: number; north: number; west: number; east: number }

export const VARS = [
  "twsKn", "twdDeg", "gustKn", "pressureHpa",
  "waveHeightM", "waveDirDeg", "wavePeriodS", "swellHeightM", "currentKn", "currentDirDeg",
] as const;
type Var = (typeof VARS)[number];

/** Gridded hourly forecast. values[var][(t * nLat + i) * nLon + j] */
export interface WeatherGrid {
  meta: WeatherGridMeta;
  values: Record<Var, (number | null)[]>;
}

const KMH_TO_KN = 1 / 1.852;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export class OpenMeteoProvider implements WeatherProvider {
  name = "Open-Meteo (Forecast + Marine)";

  async fetchGrid(bbox: BBox): Promise<WeatherGrid> {
    const span = Math.max(bbox.north - bbox.south, (bbox.east - bbox.west) * 0.8);
    const step = Math.max(1, Math.round((span / 11) * 2) / 2);
    const lats: number[] = [], lons: number[] = [];
    for (let la = Math.floor(bbox.south); la < bbox.north + step; la += step) lats.push(+la.toFixed(3));
    for (let lo = Math.floor(bbox.west); lo < bbox.east + step; lo += step) lons.push(+lo.toFixed(3));
    const pts = lats.flatMap((la) => lons.map((lo) => ({ la, lo })));
    const sources: WeatherGridMeta["sources"] = [];

    // ── Atmospheric forecast
    const atm: any[] = [];
    for (const c of chunk(pts, 100)) {
      const url = `${config.weather.forecastUrl}?latitude=${c.map((p) => p.la).join(",")}&longitude=${c.map((p) => p.lo).join(",")}` +
        `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl&wind_speed_unit=kn&forecast_days=10&timezone=GMT`;
      const res = await netFetch(url, { timeoutMs: 45_000 });
      if (!res.ok) throw new Error(`Open-Meteo forecast HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      atm.push(...(Array.isArray(j) ? j : [j]));
      sources.push({ name: "Open-Meteo Forecast API", url: url.replace(/latitude=[^&]+&longitude=[^&]+/, "latitude=…&longitude=…"), ok: true });
    }

    // ── Marine forecast (waves, swell, currents). Failure here is tolerated and reported.
    let marine: any[] | null = [];
    try {
      for (const c of chunk(pts, 100)) {
        const url = `${config.weather.marineUrl}?latitude=${c.map((p) => p.la).join(",")}&longitude=${c.map((p) => p.lo).join(",")}` +
          `&hourly=wave_height,wave_direction,wave_period,swell_wave_height,ocean_current_velocity,ocean_current_direction&forecast_days=8&cell_selection=sea&timezone=GMT`;
        const res = await netFetch(url, { timeoutMs: 45_000 });
        if (!res.ok) throw new Error(`Open-Meteo marine HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const j = await res.json();
        marine.push(...(Array.isArray(j) ? j : [j]));
        sources.push({ name: "Open-Meteo Marine API", url: url.replace(/latitude=[^&]+&longitude=[^&]+/, "latitude=…&longitude=…"), ok: true });
      }
    } catch (e) {
      if (e instanceof OfflineError) throw e;
      sources.push({ name: "Open-Meteo Marine API", url: config.weather.marineUrl, ok: false, error: (e as Error).message });
      marine = null;
    }

    const times: string[] = atm[0].hourly.time.map((t: string) => `${t}:00Z`);
    const nT = times.length, nLat = lats.length, nLon = lons.length;
    const values = Object.fromEntries(VARS.map((v) => [v, new Array(nT * nLat * nLon).fill(null)])) as WeatherGrid["values"];
    const unitCurrent = marine?.[0]?.hourly_units?.ocean_current_velocity ?? "km/h";
    const curFactor = unitCurrent === "km/h" ? KMH_TO_KN : unitCurrent === "m/s" ? 1.943844 : 1;

    pts.forEach((_, k) => {
      const i = Math.floor(k / nLon), j = k % nLon;
      const a = atm[k].hourly;
      const m = marine?.[k]?.hourly;
      const mIndex = new Map<string, number>((m?.time ?? []).map((t: string, idx: number) => [`${t}:00Z`, idx]));
      for (let t = 0; t < nT; t++) {
        const idx = (t * nLat + i) * nLon + j;
        values.twsKn[idx] = a.wind_speed_10m[t];
        values.twdDeg[idx] = a.wind_direction_10m[t];
        values.gustKn[idx] = a.wind_gusts_10m[t];
        values.pressureHpa[idx] = a.pressure_msl[t];
        const mt = mIndex.get(times[t]);
        if (m && mt != null) {
          values.waveHeightM[idx] = m.wave_height[mt];
          values.waveDirDeg[idx] = m.wave_direction[mt];
          values.wavePeriodS[idx] = m.wave_period[mt];
          values.swellHeightM[idx] = m.swell_wave_height[mt];
          const cv = m.ocean_current_velocity[mt];
          values.currentKn[idx] = cv == null ? null : +(cv * curFactor).toFixed(2);
          values.currentDirDeg[idx] = m.ocean_current_direction[mt];
        }
      }
    });

    const fetchedAt = new Date().toISOString();
    return {
      meta: {
        id: `wx_${Date.now().toString(36)}`,
        fetchedAt,
        sources,
        lats,
        lons,
        times,
        bbox: { south: lats[0], north: lats[lats.length - 1], west: lons[0], east: lons[lons.length - 1] },
        firstTime: times[0],
        lastTime: times[nT - 1],
        marineAvailable: marine != null,
      },
      values,
    };
  }
}

/* ───────────────────────── Interpolated field ───────────────────────── */

export class WeatherField {
  readonly t0: number;
  readonly tLast: number;
  readonly marineLast: number;
  constructor(readonly grid: WeatherGrid) {
    this.t0 = Date.parse(grid.meta.firstTime);
    this.tLast = Date.parse(grid.meta.lastTime);
    // Marine forecast is shorter than the atmospheric one; find its last non-null hour.
    const { lats, lons, times } = grid.meta;
    const per = lats.length * lons.length;
    let last = -1;
    for (let t = times.length - 1; t >= 0 && last < 0; t--) {
      for (let k = 0; k < per; k++) if (grid.values.waveHeightM[t * per + k] != null) { last = t; break; }
    }
    this.marineLast = last >= 0 ? Date.parse(times[last]) : -Infinity;
  }

  private frac(arr: number[], v: number): [number, number, number] {
    if (v <= arr[0]) return [0, 0, 0];
    const n = arr.length - 1;
    if (v >= arr[n]) return [n, n, 0];
    const step = arr[1] - arr[0];
    const i = Math.min(n - 1, Math.floor((v - arr[0]) / step));
    return [i, i + 1, (v - arr[i]) / step];
  }

  private sample(v: Var, t: number, lat: number, lon: number): number | null {
    const { lats, lons } = this.grid.meta;
    const [i0, i1, fi] = this.frac(lats, lat);
    const [j0, j1, fj] = this.frac(lons, lon);
    const nLat = lats.length, nLon = lons.length;
    const arr = this.grid.values[v];
    let sum = 0, w = 0;
    const corners: [number, number, number][] = [
      [i0, j0, (1 - fi) * (1 - fj)], [i0, j1, (1 - fi) * fj], [i1, j0, fi * (1 - fj)], [i1, j1, fi * fj],
    ];
    for (const [i, j, cw] of corners) {
      if (cw <= 0) continue;
      const val = arr[(t * nLat + i) * nLon + j];
      if (val == null) continue;
      sum += val * cw; w += cw;
    }
    return w > 0 ? sum / w : null;
  }

  private sampleVector(speedVar: Var, dirVar: Var, t: number, lat: number, lon: number, from: boolean) {
    // Interpolate direction via u/v components to avoid 359°→1° artefacts.
    const { lats, lons } = this.grid.meta;
    const [i0, i1, fi] = this.frac(lats, lat);
    const [j0, j1, fj] = this.frac(lons, lon);
    const nLat = lats.length, nLon = lons.length;
    let u = 0, vv = 0, w = 0;
    for (const [i, j, cw] of [[i0, j0, (1 - fi) * (1 - fj)], [i0, j1, (1 - fi) * fj], [i1, j0, fi * (1 - fj)], [i1, j1, fi * fj]] as const) {
      if (cw <= 0) continue;
      const k = (t * nLat + i) * nLon + j;
      const s = this.grid.values[speedVar][k], d = this.grid.values[dirVar][k];
      if (s == null || d == null) continue;
      const r = (d * Math.PI) / 180;
      u += s * Math.sin(r) * cw; vv += s * Math.cos(r) * cw; w += cw;
    }
    if (w === 0) return { speed: null, dir: null };
    u /= w; vv /= w;
    const dir = ((Math.atan2(u, vv) * 180) / Math.PI + 360) % 360;
    // For "from" quantities magnitude is interpolated as a scalar (more faithful than |u,v|).
    const speed = from ? this.sample(speedVar, t, lat, lon) : Math.hypot(u, vv);
    return { speed, dir };
  }

  at(lat: number, lon: number, timeMs: number): PointWeather {
    const nT = this.grid.meta.times.length;
    const ft = Math.max(0, Math.min(nT - 1, (timeMs - this.t0) / 3_600_000));
    const t0 = Math.floor(ft), t1 = Math.min(nT - 1, t0 + 1), f = ft - t0;
    const lerp = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : a + (b - a) * f);
    const pick = (v: Var) => lerp(this.sample(v, t0, lat, lon), this.sample(v, t1, lat, lon));
    const w0 = this.sampleVector("twsKn", "twdDeg", t0, lat, lon, true);
    const w1 = this.sampleVector("twsKn", "twdDeg", t1, lat, lon, true);
    const c0 = this.sampleVector("currentKn", "currentDirDeg", t0, lat, lon, false);
    const marineOk = timeMs <= this.marineLast + 3_600_000;
    const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
    return {
      time: new Date(timeMs).toISOString(),
      twsKn: r1(lerp(w0.speed, w1.speed)),
      twdDeg: w0.dir == null ? null : Math.round(f < 0.5 || w1.dir == null ? w0.dir : w1.dir),
      gustKn: r1(pick("gustKn")),
      pressureHpa: r1(pick("pressureHpa")),
      waveHeightM: marineOk ? r1(pick("waveHeightM")) : null,
      waveDirDeg: marineOk ? r1(pick("waveDirDeg")) : null,
      wavePeriodS: marineOk ? r1(pick("wavePeriodS")) : null,
      swellHeightM: marineOk ? r1(pick("swellHeightM")) : null,
      currentKn: marineOk ? (c0.speed == null ? null : Math.round(c0.speed * 100) / 100) : null,
      currentDirDeg: marineOk && c0.dir != null ? Math.round(c0.dir) : null,
      beyondForecast: timeMs > this.tLast,
    };
  }

  /** Grid values at one forecast hour, for drawing on the map. */
  snapshot(timeMs: number) {
    const { lats, lons } = this.grid.meta;
    const out: (PointWeather & { lat: number; lon: number })[] = [];
    for (const lat of lats) for (const lon of lons) out.push({ lat, lon, ...this.at(lat, lon, timeMs) });
    return out;
  }
}

/* ───────────────────────── Service with cache ───────────────────────── */

const cacheFile = (id: string) => path.join(config.cacheDir, `${id}.json`);
const indexFile = path.join(config.cacheDir, "weather-index.json");

export class WeatherService {
  private grid: WeatherGrid | null = null;
  private field: WeatherField | null = null;
  private lastError: string | null = null;
  private fromCache = false;

  constructor(private provider: WeatherProvider) {
    // Load the most recent cached forecast on start so the boat has *something* offline,
    // clearly flagged with its retrieval time.
    try {
      const idx = JSON.parse(fs.readFileSync(indexFile, "utf8")) as { latest: string };
      this.setGrid(JSON.parse(fs.readFileSync(cacheFile(idx.latest), "utf8")), true);
    } catch { /* no cache yet */ }
  }

  private setGrid(g: WeatherGrid, fromCache: boolean) {
    this.grid = g;
    this.field = new WeatherField(g);
    this.fromCache = fromCache;
  }

  getField(): WeatherField | null {
    return this.field;
  }

  covers(b: BBox): boolean {
    const m = this.grid?.meta.bbox;
    return !!m && m.south <= b.south && m.north >= b.north && m.west <= b.west && m.east >= b.east;
  }

  async refresh(bbox: BBox): Promise<WeatherStatus> {
    try {
      const g = await this.provider.fetchGrid(bbox);
      fs.writeFileSync(cacheFile(g.meta.id), JSON.stringify(g));
      fs.writeFileSync(indexFile, JSON.stringify({ latest: g.meta.id, fetchedAt: g.meta.fetchedAt }));
      this.setGrid(g, false);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    }
    return this.status();
  }

  status(): WeatherStatus {
    const meta = this.grid?.meta ?? null;
    const ageMinutes = meta ? Math.round((Date.now() - Date.parse(meta.fetchedAt)) / 60000) : null;
    return {
      available: !!meta,
      meta,
      ageMinutes,
      stale: ageMinutes == null || ageMinutes > config.weather.staleAfterMinutes || this.lastError != null,
      lastError: this.lastError,
      fromCache: this.fromCache,
    };
  }
}
