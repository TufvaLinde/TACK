import type {
  CandidateRoute,
  EffectiveObjectives,
  LatLon,
  LearnedCorrection,
  PolarTable,
  RouteMetrics,
  RouteTrackPoint,
  RoutingResult,
  SailingStrategy,
  VesselConfig,
} from "../../shared/types.js";
import { correctionFactor } from "../vessel/learning.js";
import { effectiveCourseSpeed, polarSpeed, vmgAngles } from "../vessel/polar.js";
import type { WeatherField } from "../weather/openMeteo.js";
import type { StrategyModule } from "../strategies/runtime.js";
import { angleDiff, bearingDeg, destination, distanceNm, interpolateGC, isLand, segmentCrossesLand } from "./geo.js";

// Simplified weather routing. All outputs are ESTIMATES computed from the forecast and
// the vessel polar; they are not observations and this is not certified navigation software.

export interface RoutingContext {
  field: WeatherField;
  polar: PolarTable;
  correction: LearnedCorrection | null;
  vessel: VesselConfig;
  objectives: EffectiveObjectives;
  departureMs: number;
  weatherFetchedAt: string | null;
  weatherStale: boolean;
  strategy: StrategyModule; // versioned routing strategy (production unless benchmarking)
  strategyVersion: string;
}

const STRATEGY: Record<SailingStrategy, { reefAboveKn: number; motorBelowKn: number; trimFactor: number; minUpwindTwa: number; label: string }> = {
  performance: { reefAboveKn: 25, motorBelowKn: 3.5, trimFactor: 1.0, minUpwindTwa: 0, label: "full sail, motor below 3.5 kn" },
  comfort: { reefAboveKn: 17, motorBelowKn: 3.5, trimFactor: 0.94, minUpwindTwa: 58, label: "early reefing, footing off upwind (≥ 58° TWA), motor-sail below 3.5 kn" },
  "sail-first": { reefAboveKn: 22, motorBelowKn: 1.8, trimFactor: 1.0, minUpwindTwa: 0, label: "sail whenever possible, motor only in near-calm (< 1.8 kn)" },
};

const ARRIVAL_RADIUS_NM = 3;
const MAX_HOURS = 24 * 21;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 1);

/**
 * Boat speed through the water for a sailing mode. This is THE speed model: the router,
 * the isochrone search and the benchmark evaluator all call it, so a strategy change
 * affects predictions everywhere consistently. Strategy output is clamped here.
 */
export function sailingSpeed(a: {
  polar: PolarTable; correction: LearnedCorrection | null; strategy: StrategyModule; mode: SailingStrategy;
  tws: number; twa: number; waveM: number | null; wavePeriod: number | null; waveRel: number | null;
}): number {
  const s = STRATEGY[a.mode];
  const reefed = a.tws > s.reefAboveKn;
  let v = polarSpeed(a.polar, a.tws, a.twa) * correctionFactor(a.correction, a.tws, a.twa) * s.trimFactor;
  if (reefed) v *= 0.9;
  v *= clamp(a.strategy.speedFactor({ twsKn: a.tws, twaDeg: Math.min(180, Math.abs(a.twa)), waveHeightM: a.waveM, wavePeriodS: a.wavePeriod, waveRelDeg: a.waveRel, reefed }), 0.3, 1.3);
  return v;
}

export const sailingModeMinUpwind = (mode: SailingStrategy) => STRATEGY[mode].minUpwindTwa;

function boatSpeedFn(ctx: RoutingContext, mode: SailingStrategy, wx: { waveHeightM: number | null; wavePeriodS: number | null; waveDirDeg: number | null }, courseDeg: number) {
  const waveRel = wx.waveDirDeg != null ? Math.abs(angleDiff(wx.waveDirDeg, courseDeg)) : null;
  return (tws: number, twa: number) =>
    sailingSpeed({ polar: ctx.polar, correction: ctx.correction, strategy: ctx.strategy, mode, tws, twa, waveM: wx.waveHeightM, wavePeriod: wx.wavePeriodS, waveRel });
}

function hourComfort(p: { tws: number; twa: number; waveM: number | null; wavePeriod: number | null; waveRel: number | null; motoring: boolean; reefed: boolean }) {
  let c = 10;
  if (p.waveM != null) {
    if (p.waveM > 1) c -= 1.4 * (p.waveM - 1);
    if (p.wavePeriod != null && p.wavePeriod < 7 && p.waveM > 1.5) c -= 1; // short, steep sea
    if (p.waveRel != null && p.waveRel > 60 && p.waveRel < 120 && p.waveM > 2) c -= 1; // beam sea, rolling
  }
  if (!p.motoring) {
    if (p.twa < 50) c -= p.tws > 18 ? 3.5 : 3; // hard on the wind: heel and slamming
    else if (p.twa < 65) c -= p.tws > 18 ? 2 : 1.5; // footing off
    if (p.twa > 160 && (p.waveM ?? 0) > 1.5) c -= 1; // dead downwind rolling
  }
  const windPenalty = p.tws > 20 ? (p.tws - 20) * 0.25 : 0;
  c -= p.reefed ? windPenalty * 0.5 : windPenalty; // reefed early = less heel
  if (p.motoring) c -= p.twa < 50 && (p.waveM ?? 0) > 2 ? 1.5 : 0.5; // motoring into a head sea is wet and jerky
  return Math.max(0, Math.min(10, c));
}

/** Follow a waypoint list hour by hour through the forecast. */
export function simulate(ctx: RoutingContext, waypoints: LatLon[], strategy: SailingStrategy) {
  const dt = 1;
  let pos = { ...waypoints[0] };
  let k = 1;
  let tMs = ctx.departureMs;
  const final = waypoints[waypoints.length - 1];
  const track: RouteTrackPoint[] = [];
  const acc = { dist: 0, motor: 0, upwind: 0, tws: [] as number[], gust: 0, waves: [] as number[], comfort: [] as number[], beyond: 0, curGain: 0, bsp: [] as number[], good: 0 };
  let reached = false;
  let hours = 0;
  const s = STRATEGY[strategy];

  while (hours < MAX_HOURS) {
    while (k < waypoints.length - 1 && distanceNm(pos, waypoints[k]) < 12) k++;
    const target = waypoints[k];
    const brg = bearingDeg(pos, target);
    const wx = ctx.field.at(pos.lat, pos.lon, tMs);
    const tws = wx.twsKn ?? 0;
    const twd = wx.twdDeg ?? 0;
    const courseTwa = Math.abs(angleDiff(twd, brg));
    const speedAt = boatSpeedFn(ctx, strategy, wx, brg);
    const eff = effectiveCourseSpeed(speedAt, ctx.polar, tws, courseTwa, s.minUpwindTwa);
    const leadHours = (tMs - ctx.departureMs) / 3_600_000;
    let vmc = eff.vmc * clamp(ctx.strategy.uncertaintyFactor({ leadHours, beyondForecast: wx.beyondForecast }), 0.5, 1.05);
    let motoring = false;
    if (vmc < s.motorBelowKn) {
      motoring = true;
      const seaPenalty = wx.waveHeightM != null && wx.waveHeightM > 2 && courseTwa < 70 ? 0.85 : 1;
      vmc = Math.max(vmc, ctx.vessel.engine.cruiseSpeedKn * seaPenalty);
    }
    const along = wx.currentKn != null && wx.currentDirDeg != null ? wx.currentKn * Math.cos(((wx.currentDirDeg - brg) * Math.PI) / 180) : 0;
    const sog = Math.max(0.3, vmc + along);
    const reefed = !motoring && tws > s.reefAboveKn;
    const waveRel = wx.waveDirDeg != null ? Math.abs(angleDiff(wx.waveDirDeg, brg)) : null;

    track.push({
      t: new Date(tMs).toISOString(), lat: +pos.lat.toFixed(4), lon: +pos.lon.toFixed(4),
      twsKn: tws, twaDeg: Math.round(motoring ? courseTwa : eff.sailedTwa), bspKn: +vmc.toFixed(2), sogKn: +sog.toFixed(2),
      waveM: wx.waveHeightM, motoring, reefed,
    });

    const remaining = distanceNm(pos, final);
    const isLastLeg = k === waypoints.length - 1;
    let frac = 1;
    if (isLastLeg && sog * dt >= remaining - ARRIVAL_RADIUS_NM) {
      frac = Math.max(0.05, (remaining - ARRIVAL_RADIUS_NM) / (sog * dt));
      reached = true;
    }
    const stepNm = sog * dt * frac;
    pos = destination(pos, brg, stepNm);
    acc.dist += stepNm;
    acc.curGain += along * dt * frac;
    acc.tws.push(tws);
    acc.bsp.push(vmc);
    acc.gust = Math.max(acc.gust, wx.gustKn ?? 0);
    if (wx.waveHeightM != null) acc.waves.push(wx.waveHeightM);
    if (motoring) acc.motor += dt * frac;
    if (!motoring && eff.manoeuvre === "tacking") acc.upwind += dt * frac;
    if (!motoring && tws >= 10 && tws <= 20 && eff.sailedTwa >= 60 && eff.sailedTwa <= 150 && (wx.waveHeightM ?? 0) < 2.5) acc.good += dt * frac;
    if (wx.beyondForecast) acc.beyond += dt * frac;
    acc.comfort.push(hourComfort({ tws, twa: motoring ? courseTwa : eff.sailedTwa, waveM: wx.waveHeightM, wavePeriod: wx.wavePeriodS, waveRel, motoring, reefed }));
    tMs += dt * frac * 3_600_000;
    hours += dt * frac;
    if (reached) break;
  }
  if (reached) track.push({ ...track[track.length - 1], t: new Date(tMs).toISOString(), lat: +pos.lat.toFixed(4), lon: +pos.lon.toFixed(4) });

  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const first12 = track.slice(0, 12);
  const metrics: RouteMetrics = {
    etaIso: reached ? new Date(tMs).toISOString() : null,
    reachedDestination: reached,
    durationHours: r1(hours),
    distanceNm: Math.round(acc.dist),
    meanSogKn: r1(acc.dist / Math.max(hours, 0.1)),
    meanBspKn: r1(mean(acc.bsp)),
    motoringHours: r1(acc.motor),
    fuelLitres: ctx.vessel.engine.fuelBurnLph != null ? Math.round(acc.motor * ctx.vessel.engine.fuelBurnLph) : null,
    sailingHoursPct: Math.round(100 * (1 - acc.motor / Math.max(hours, 0.1))),
    goodSailingPct: Math.round((100 * acc.good) / Math.max(hours, 0.1)),
    wind: {
      meanKn: r1(mean(acc.tws)), maxKn: r1(Math.max(0, ...acc.tws)), maxGustKn: r1(acc.gust),
      hoursAbove20: acc.tws.filter((x) => x > 20).length, hoursAbove25: acc.tws.filter((x) => x > 25).length,
    },
    waves: {
      meanM: acc.waves.length ? r1(mean(acc.waves)) : null,
      maxM: acc.waves.length ? r1(Math.max(...acc.waves)) : null,
      hoursAbove2_5: acc.waves.filter((x) => x > 2.5).length,
    },
    upwindHours: r1(acc.upwind),
    comfortIndex: r1(mean(acc.comfort)),
    next12h: {
      maxTwsKn: r1(Math.max(0, ...first12.map((p) => p.twsKn))),
      maxWaveM: first12.some((p) => p.waveM != null) ? r1(Math.max(...first12.map((p) => p.waveM ?? 0))) : null,
      comfortIndex: r1(mean(acc.comfort.slice(0, 12))),
      motoringHours: first12.filter((p) => p.motoring).length,
    },
    hoursBeyondForecast: r1(acc.beyond),
    currentGainNm: r1(acc.curGain),
    landCrossing: false,
  };
  return { track, metrics };
}

/* ───────────────────────── Isochrone search ───────────────────────── */

interface IsoNode { pos: LatLon; t: number; parent: IsoNode | null }

export function isochroneRoute(ctx: RoutingContext, start: LatLon, dest: LatLon): LatLon[] | null {
  const stepH = 2;
  const brgSD = bearingDeg(start, dest);
  let front: IsoNode[] = [{ pos: start, t: ctx.departureMs, parent: null }];

  const finish = (node: IsoNode) => {
    const path: LatLon[] = [dest];
    for (let n: IsoNode | null = node; n; n = n.parent) path.push(n.pos);
    path.reverse();
    // keep roughly 6-hourly turning points
    return path.filter((_, i) => i === 0 || i === path.length - 1 || i % 3 === 0);
  };
  for (let step = 0; step < MAX_HOURS / stepH; step++) {
    const candidates: IsoNode[] = [];
    let arrived: { node: IsoNode; frac: number } | null = null;
    for (const node of front) {
      const wx = ctx.field.at(node.pos.lat, node.pos.lon, node.t);
      const tws = wx.twsKn ?? 0, twd = wx.twdDeg ?? 0;
      const toDest = bearingDeg(node.pos, dest);
      const dRemain = distanceNm(node.pos, dest);
      for (let h = -110; h <= 110; h += 5) {
        const hdg = (toDest + h + 360) % 360;
        const twa = Math.abs(angleDiff(twd, hdg));
        let bsp = boatSpeedFn(ctx, "performance", wx, hdg)(tws, twa);
        if (bsp < STRATEGY.performance.motorBelowKn) {
          if (Math.abs(h) > 10) continue; // under engine, steer for the destination
          bsp = Math.max(bsp, ctx.vessel.engine.cruiseSpeedKn);
        }
        // ground velocity = boat vector + current vector
        let ve = bsp * Math.sin((hdg * Math.PI) / 180), vn = bsp * Math.cos((hdg * Math.PI) / 180);
        if (wx.currentKn != null && wx.currentDirDeg != null) {
          ve += wx.currentKn * Math.sin((wx.currentDirDeg * Math.PI) / 180);
          vn += wx.currentKn * Math.cos((wx.currentDirDeg * Math.PI) / 180);
        }
        const sog = Math.hypot(ve, vn);
        const cog = (Math.atan2(ve, vn) * 180) / Math.PI;
        const along = sog * Math.cos(((cog - toDest) * Math.PI) / 180);
        if (along > 0.5 && along * stepH >= dRemain - ARRIVAL_RADIUS_NM) {
          const frac = (dRemain - ARRIVAL_RADIUS_NM) / (along * stepH);
          if (!arrived || frac < arrived.frac) arrived = { node, frac };
          continue;
        }
        const p = destination(node.pos, cog, sog * stepH);
        if (isLand(p)) continue;
        candidates.push({ pos: p, t: node.t + stepH * 3_600_000, parent: node });
      }
    }
    if (arrived) return finish(arrived.node);
    // Prune: per 1.5° sector (bearing from start), keep the node that has progressed furthest
    // toward the destination (classic isochrone envelope).
    const sectors = new Map<number, { node: IsoNode; score: number }>();
    for (const c of candidates) {
      const rel = angleDiff(bearingDeg(start, c.pos), brgSD);
      if (Math.abs(rel) > 70) continue;
      const key = Math.round(rel / 1.5);
      const score = -distanceNm(c.pos, dest);
      const prev = sectors.get(key);
      if (!prev || score > prev.score) sectors.set(key, { node: c, score });
    }
    front = [...sectors.values()].map((x) => x.node);
    if (!front.length) return null;
  }
  return null;
}

/* ───────────────────────── Candidate generation ───────────────────────── */

function arc(start: LatLon, dest: LatLon, offsetNm: number): LatLon[] {
  const brg = bearingDeg(start, dest);
  const pts: LatLon[] = [start];
  for (const [f, k] of [[0.25, 0.7], [0.5, 1], [0.75, 0.7]] as const) {
    const base = interpolateGC(start, dest, f);
    const along = bearingDeg(base, dest);
    pts.push(destination(base, (along + (offsetNm >= 0 ? -90 : 90) + 360) % 360, Math.abs(offsetNm) * k));
  }
  pts.push(dest);
  void brg;
  return pts;
}

function polylineCrossesLand(pts: LatLon[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    // ignore the final approach (destination harbours sit on the coastline)
    if (i === pts.length - 1) {
      const d = distanceNm(pts[i - 1], pts[i]);
      if (d < 8) continue;
      const cut = interpolateGC(pts[i - 1], pts[i], (d - 6) / d);
      if (segmentCrossesLand(pts[i - 1], cut)) return true;
      continue;
    }
    if (segmentCrossesLand(pts[i - 1], pts[i])) return true;
  }
  return false;
}

function constraintCheck(ctx: RoutingContext, track: RouteTrackPoint[], metrics: RouteMetrics): string[] {
  const v: string[] = [];
  const h = ctx.objectives.hard;
  const windLimit = Math.min(ctx.vessel.operationalLimits.maxTwsKn, h.maxTwsKn ?? Infinity);
  const waveLimit = Math.min(ctx.vessel.operationalLimits.maxWaveM, h.maxWaveM ?? Infinity);
  if (metrics.wind.maxKn > windLimit) v.push(`Forecast wind ${metrics.wind.maxKn} kn exceeds the ${windLimit} kn limit`);
  if (metrics.waves.maxM != null && metrics.waves.maxM > waveLimit) v.push(`Forecast waves ${metrics.waves.maxM} m exceed the ${waveLimit} m limit`);
  if (!metrics.reachedDestination) v.push("Does not reach the destination within the 21-day simulation window");
  if (h.arrivalDeadline && (!metrics.etaIso || Date.parse(metrics.etaIso) > Date.parse(h.arrivalDeadline)))
    v.push(`Estimated arrival misses the deadline (${new Date(h.arrivalDeadline).toUTCString().slice(0, 22)} UTC)`);
  for (const a of h.restrictedAreas) {
    if (track.some((p) => distanceNm(p, a) < a.radiusNm)) v.push(`Passes through restricted area "${a.name}"`);
  }
  if (metrics.landCrossing) v.push("Route geometry crosses land");
  return v;
}

export function computeRoutes(ctx: RoutingContext, start: LatLon, dest: LatLon): RoutingResult {
  const warnings: string[] = [];
  const gc = distanceNm(start, dest);
  const offset = Math.max(60, Math.min(240, gc * 0.13));
  const midGC = interpolateGC(start, dest, 0.5);
  const specs: { id: string; name: string; description: string; strategy: SailingStrategy; method: "isochrone" | "waypoint"; waypoints: LatLon[] | null }[] = [];

  const iso = isochroneRoute(ctx, start, dest);
  if (iso) specs.push({ id: "R1", name: "Isochrone-optimised", description: "Track found by isochrone search through the hourly forecast (2 h steps, 5° headings), aiming for the earliest arrival; full sail, motor below 3.5 kn.", strategy: "performance", method: "isochrone", waypoints: iso });
  else warnings.push("Isochrone search did not reach the destination; fastest-route candidate omitted.");

  specs.push({ id: "R2", name: "Direct", description: "Great-circle track, full sail, motor below 3.5 kn.", strategy: "performance", method: "waypoint", waypoints: [start, dest] });

  for (const [id, sign, strategy] of [["R3", 1, "performance"], ["R4", -1, "comfort"]] as const) {
    let wp: LatLon[] | null = null;
    for (const scale of [1, 0.6, 0.35]) {
      const cand = arc(start, dest, sign * offset * scale);
      if (!polylineCrossesLand(cand)) { wp = cand; break; }
    }
    if (!wp) { warnings.push(`${id}: every lateral offset crosses land; candidate skipped.`); continue; }
    const side = wp[2].lat > midGC.lat ? "Northern" : "Southern";
    const dist = Math.round(distanceNm(midGC, wp[2]));
    specs.push({
      id,
      name: `${side} arc${strategy === "comfort" ? " — comfort" : ""}`,
      description: `Bends ${dist} nm ${side.toLowerCase()} of the direct track; ${STRATEGY[strategy].label}.`,
      strategy, method: "waypoint", waypoints: wp,
    });
  }
  if (iso) specs.push({ id: "R6", name: "Isochrone track — comfort", description: `Same track as R1; ${STRATEGY.comfort.label}.`, strategy: "comfort", method: "isochrone", waypoints: iso });
  specs.push({ id: "R5", name: "Direct — sail first", description: `Great-circle track; ${STRATEGY["sail-first"].label}.`, strategy: "sail-first", method: "waypoint", waypoints: [start, dest] });

  const routes: CandidateRoute[] = specs.map((s) => {
    const { track, metrics } = simulate(ctx, s.waypoints!, s.strategy);
    metrics.landCrossing = s.method === "waypoint" && polylineCrossesLand(s.waypoints!);
    const violations = constraintCheck(ctx, track, metrics);
    return { id: s.id, name: s.name, description: s.description, strategy: s.strategy, method: s.method, waypoints: s.waypoints!, track, metrics, hardConstraintViolations: violations, eligible: violations.length === 0 };
  });

  if (routes.some((r) => r.metrics.hoursBeyondForecast > 0))
    warnings.push("Part of the passage extends beyond the forecast horizon; conditions there are held at the last forecast hour and are low-confidence.");
  if (ctx.weatherStale) warnings.push("Weather forecast is stale — routing uses an old forecast.");
  void vmgAngles;

  return {
    id: `rt_${Date.now().toString(36)}`,
    computedAt: new Date().toISOString(),
    start, destination: dest,
    departure: new Date(ctx.departureMs).toISOString(),
    weatherFetchedAt: ctx.weatherFetchedAt,
    weatherStale: ctx.weatherStale,
    strategyVersion: ctx.strategyVersion,
    correctionApplied: !!ctx.correction && ctx.correction.summary.used > 0,
    routes,
    warnings,
  };
}
