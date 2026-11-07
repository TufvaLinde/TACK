import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BenchmarkScenario, VesselProfile } from "../../shared/intelligence.js";
import type { LearnedCorrection, LogEntry, PolarTable } from "../../shared/types.js";
import { config } from "../config.js";
import { netFetch } from "../net.js";
import { angleDiff, bearingDeg, distanceNm, interpolateGC } from "../routing/geo.js";
import type { LoadedStrategy } from "../strategies/runtime.js";
import { sailingSpeed } from "../routing/engine.js";
import { buildCorrection, sailKey } from "../vessel/learning.js";
import { effectiveCourseSpeed } from "../vessel/polar.js";
import { generateSynthetic } from "./synthetic.js";

// Benchmark dataset.
//  • historical-log: REAL legs from imported logbooks — consecutive sailing entries (no engine),
//    observed speed made good between logged positions, paired with Open-Meteo's ARCHIVED
//    forecast (historical-forecast API) and marine data for that place and hour.
//  • synthetic: clearly labelled generated scenarios (see synthetic.ts).
// The dev / held-out split is deterministic and fixed: real legs are split by calendar day
// (to limit leakage between neighbouring legs), synthetic ones by id hash.

const HIST_CACHE = path.join(config.cacheDir, "historical-weather.json");
const hash = (s: string) => parseInt(crypto.createHash("sha1").update(s).digest("hex").slice(0, 8), 16);

export const splitOf = (sc: { provenance: string; id: string; t: string }): "dev" | "heldout" =>
  sc.provenance === "historical-log" ? (hash(`day:${sc.t.slice(0, 10)}`) % 3 === 0 ? "heldout" : "dev") : hash(sc.id) % 100 < 35 ? "heldout" : "dev";

type WxKey = string;
type Wx = { tws: number; twd: number; hs: number | null; tp: number | null; wd: number | null; cur: number | null; curDir: number | null };

async function fetchHistoricalWeather(points: { key: WxKey; lat: number; lon: number; hour: string }[]): Promise<Record<WxKey, Wx>> {
  const cache: Record<WxKey, Wx> = fs.existsSync(HIST_CACHE) ? JSON.parse(fs.readFileSync(HIST_CACHE, "utf8")) : {};
  const missing = points.filter((p) => !cache[p.key]);
  const byDate = new Map<string, typeof missing>();
  for (const p of missing) byDate.set(p.hour.slice(0, 10), [...(byDate.get(p.hour.slice(0, 10)) ?? []), p]);
  for (const [date, pts] of byDate) {
    const lat = pts.map((p) => p.lat.toFixed(3)).join(","), lon = pts.map((p) => p.lon.toFixed(3)).join(",");
    const wUrl = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=GMT`;
    const mUrl = `${config.weather.marineUrl}?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=wave_height,wave_period,wave_direction,ocean_current_velocity,ocean_current_direction&cell_selection=sea&timezone=GMT`;
    const [w, m] = await Promise.all([netFetch(wUrl).then((r) => r.json()), netFetch(mUrl).then((r) => r.json())]);
    const wa = Array.isArray(w) ? w : [w], ma = Array.isArray(m) ? m : [m];
    pts.forEach((p, i) => {
      const h = Number(p.hour.slice(11, 13));
      const ww = wa[i]?.hourly, mm = ma[i]?.hourly;
      if (!ww || ww.wind_speed_10m?.[h] == null) return;
      cache[p.key] = {
        tws: ww.wind_speed_10m[h], twd: ww.wind_direction_10m[h],
        hs: mm?.wave_height?.[h] ?? null, tp: mm?.wave_period?.[h] ?? null, wd: mm?.wave_direction?.[h] ?? null,
        cur: mm?.ocean_current_velocity?.[h] != null ? mm.ocean_current_velocity[h] / 1.852 : null, curDir: mm?.ocean_current_direction?.[h] ?? null,
      };
    });
  }
  fs.writeFileSync(HIST_CACHE, JSON.stringify(cache));
  return cache;
}

export async function buildRealLegs(entries: LogEntry[], vessel: VesselProfile): Promise<{ legs: BenchmarkScenario[]; skipped: Record<string, number> }> {
  const obs = entries.filter((e) => e.kind === "observation" && e.observations?.position).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const skipped: Record<string, number> = {};
  const skip = (r: string) => (skipped[r] = (skipped[r] ?? 0) + 1);
  const raw: { a: LogEntry; b: LogEntry; mid: { lat: number; lon: number }; midT: string; dt: number; dist: number }[] = [];
  for (let i = 1; i < obs.length; i++) {
    const a = obs[i - 1], b = obs[i];
    const ka = sailKey(a.observations!.sailPlan), kb = sailKey(b.observations!.sailPlan);
    const dt = (Date.parse(b.timestamp) - Date.parse(a.timestamp)) / 3_600_000;
    const dist = distanceNm(a.observations!.position!, b.observations!.position!);
    if (["motoring", "motor-sailing", "unknown"].includes(ka) || ["motoring", "motor-sailing", "unknown"].includes(kb)) { skip("engine used or sails unknown at either end"); continue; }
    if (dt < 1 || dt > 8) { skip("leg shorter than 1 h or longer than 8 h"); continue; }
    if (dist < 3) { skip("less than 3 nm between logged positions"); continue; }
    const sog = dist / dt;
    if (sog < 1 || sog > 14) { skip("implausible speed made good"); continue; }
    const midT = new Date((Date.parse(a.timestamp) + Date.parse(b.timestamp)) / 2);
    midT.setUTCMinutes(0, 0, 0);
    raw.push({ a, b, mid: interpolateGC(a.observations!.position!, b.observations!.position!, 0.5), midT: midT.toISOString(), dt, dist });
  }
  const wx = await fetchHistoricalWeather(raw.map((r) => ({ key: `${r.mid.lat.toFixed(2)},${r.mid.lon.toFixed(2)},${r.midT.slice(0, 13)}`, lat: r.mid.lat, lon: r.mid.lon, hour: r.midT })));
  const legs: BenchmarkScenario[] = [];
  for (const r of raw) {
    const w = wx[`${r.mid.lat.toFixed(2)},${r.mid.lon.toFixed(2)},${r.midT.slice(0, 13)}`];
    if (!w) { skip("no archived forecast for the leg"); continue; }
    const id = `leg_${r.a.id}`;
    const sc: BenchmarkScenario = {
      id, provenance: "historical-log", split: "dev", vessel, t: r.a.timestamp,
      from: r.a.observations!.position!, to: r.b.observations!.position!,
      durationH: +r.dt.toFixed(3), distanceNm: +r.dist.toFixed(2), courseDeg: +bearingDeg(r.a.observations!.position!, r.b.observations!.position!).toFixed(1),
      observedSogKn: +(r.dist / r.dt).toFixed(3),
      weather: { source: "Open-Meteo historical forecast + marine archive", twsKn: w.tws, twdDeg: w.twd, waveHeightM: w.hs, wavePeriodS: w.tp, waveDirDeg: w.wd, currentKn: w.cur, currentDirDeg: w.curDir },
      sailKey: sailKey(r.a.observations!.sailPlan),
      notes: ["log times have no time zone (treated as UTC)", "speed made good from logged positions (includes current and leeway)"],
    };
    sc.split = splitOf(sc);
    legs.push(sc);
  }
  return { legs, skipped };
}

export interface Dataset {
  builtAt: string;
  scenarios: BenchmarkScenario[];
  skipped: Record<string, number>;
  realCorrection: LearnedCorrection | null; // learned from DEV real legs only (no held-out leakage)
}

let current: Dataset | null = null;

export async function buildDataset(historicalEntries: LogEntry[], polar: PolarTable, realVessel: VesselProfile): Promise<Dataset> {
  const { legs, skipped } = historicalEntries.length ? await buildRealLegs(historicalEntries, realVessel) : { legs: [], skipped: {} };
  const synthetic = generateSynthetic(polar).map((s) => ({ ...s, split: splitOf(s) }));
  const devDays = new Set(legs.filter((l) => l.split === "dev").map((l) => l.t.slice(0, 10)));
  const devEntries = historicalEntries.filter((e) => devDays.has(e.timestamp.slice(0, 10)));
  current = {
    builtAt: new Date().toISOString(),
    scenarios: [...legs, ...synthetic],
    skipped,
    realCorrection: devEntries.length ? buildCorrection(devEntries, polar) : null,
  };
  return current;
}

export const dataset = {
  current: () => current,
  /** The ONLY accessor the improvement agent may use. */
  dev: () => (current?.scenarios ?? []).filter((s) => s.split === "dev"),
  /** Used exclusively by the benchmark evaluator. */
  heldout: () => (current?.scenarios ?? []).filter((s) => s.split === "heldout"),
};

/* ───────────── shared prediction (same speed model as the router) ───────────── */

export function predictLeg(strategy: LoadedStrategy, polar: PolarTable, correction: LearnedCorrection | null, sc: BenchmarkScenario) {
  const w = sc.weather;
  const courseTwa = Math.abs(angleDiff(w.twdDeg, sc.courseDeg));
  const waveRel = w.waveDirDeg != null ? Math.abs(angleDiff(w.waveDirDeg, sc.courseDeg)) : null;
  const speedAt = (tws: number, twa: number) =>
    sailingSpeed({ polar, correction: sc.provenance === "synthetic" ? null : correction, strategy: strategy.module, mode: "performance", tws, twa, waveM: w.waveHeightM, wavePeriod: w.wavePeriodS, waveRel });
  const eff = effectiveCourseSpeed(speedAt, polar, w.twsKn, courseTwa);
  const u = strategy.module.uncertaintyFactor({ leadHours: 0, beyondForecast: false });
  const along = w.currentKn != null && w.currentDirDeg != null ? w.currentKn * Math.cos(((w.currentDirDeg - sc.courseDeg) * Math.PI) / 180) : 0;
  const sog = Math.max(0.3, eff.vmc * (Number.isFinite(u) ? Math.max(0.5, Math.min(1.05, u)) : 1) + along);
  return { predSogKn: sog, predDurationH: sc.distanceNm / sog, courseTwa };
}

export const seaBucket = (hs: number | null) => (hs == null ? "unknown" : hs < 1.5 ? "<1.5 m" : hs < 2.5 ? "1.5–2.5 m" : hs < 3.5 ? "2.5–3.5 m" : "≥3.5 m");
