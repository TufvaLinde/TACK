import type {
  CorrectionBin,
  LearnedCorrection,
  LogEntry,
  PerformanceObservation,
  PolarTable,
  SailPlan,
} from "../../shared/types.js";
import { polarSpeed } from "./polar.js";

// Learned performance correction.
//
// The baseline polar is never modified. Instead we keep a separate multiplicative
// correction per (TWS, TWA) bin for the full-sail configuration, learned from logbook
// observations. Each observation is weighted by data quality, and bin factors are
// shrunk toward 1.0 (the baseline) so that a handful of noisy entries cannot
// rewrite the boat's performance. Observations taken under engine, reefs or partial
// sail are recorded descriptively but do not move the full-sail correction.

export const TWS_EDGES = [0, 8, 12, 16, 22, 60];
export const TWA_EDGES = [0, 60, 100, 140, 181];
const PRIOR_STRENGTH = 4; // equivalent "virtual observations" at ratio 1.0

export function sailKey(sp: SailPlan | null): string {
  if (!sp) return "unknown";
  if (sp.engine) return sp.main === "down" && sp.headsail === "down" ? "motoring" : "motor-sailing";
  const reefed = sp.main === "reefed" || sp.headsail === "reefed" || (sp.reefLevel ?? 0) > 0;
  if (sp.main === "full" && sp.headsail === "full") return "full";
  if (reefed && sp.main !== "down" && sp.headsail !== "down") return "reefed";
  if (sp.main === "down" && sp.headsail !== "down" && sp.headsail !== "unknown") return "headsail-only";
  if (sp.headsail === "down" && sp.main !== "down" && sp.main !== "unknown") return "main-only";
  return "unknown";
}

function twaFrom(twd: number, course: number): number {
  let d = Math.abs((((twd - course) % 360) + 540) % 360 - 180);
  return d; // 0..180
}

export function toObservation(entry: LogEntry, polar: PolarTable): PerformanceObservation | null {
  const o = entry.observations;
  if (!o) return null;
  const speed = o.stwKn ?? o.sogKn;
  const course = o.headingDeg ?? o.cogDeg;
  if (speed == null || course == null || o.twsKn == null || o.twdDeg == null) return null;

  const reasons: string[] = [];
  let weight = 1;
  let used = true;
  const speedType = o.stwKn != null ? "stw" : "sog";
  if (speedType === "sog") { weight *= 0.5; reasons.push("speed over ground used (current and leeway not separated)"); }
  if (o.headingDeg == null) { weight *= 0.8; reasons.push("course over ground used instead of heading"); }
  if (o.windReference === "apparent") { used = false; reasons.push("excluded: apparent wind — conversion to true wind not implemented"); }
  else if (o.windReference !== "true") { weight *= 0.7; reasons.push("wind reference (true/apparent) not recorded"); }
  const sea = o.seaState ?? entry.interpretation?.seaState ?? null;
  if (sea === "rough" || sea === "very rough") { weight *= 0.6; reasons.push(`sea state ${sea}`); }
  if (o.sailPlan?.engine == null) { weight *= 0.6; reasons.push("engine use not recorded"); }
  weight *= Math.max(0.2, entry.extraction?.confidence ?? 0.5);

  const twa = twaFrom(o.twdDeg, course);
  const predicted = polarSpeed(polar, o.twsKn, twa);
  const ratio = predicted > 0 ? speed / predicted : NaN;
  const key = sailKey(o.sailPlan);

  if (o.twsKn < 4) { used = false; reasons.push("excluded: wind below 4 kn — too light for a reliable comparison"); }
  if (twa < 30) { used = false; reasons.push("excluded: wind angle inside the no-go zone"); }
  if (!(predicted > 1)) { used = false; reasons.push("excluded: baseline prediction too low to compare"); }
  if (Number.isFinite(ratio) && (ratio < 0.35 || ratio > 1.7)) { used = false; reasons.push("excluded: implausible observed/predicted ratio — likely a data error"); }
  if (key !== "full") { used = false; reasons.push(`excluded: sail configuration "${key}" (engine, reefs or partial sail) — kept separate from the full-sail correction`); }

  return {
    entryId: entry.id,
    timestamp: entry.timestamp,
    twsKn: o.twsKn,
    twaDeg: Math.round(twa),
    observedKn: speed,
    speedType,
    predictedKn: Math.round(predicted * 100) / 100,
    ratio: Number.isFinite(ratio) ? Math.round(ratio * 1000) / 1000 : 0,
    weight: Math.round(weight * 1000) / 1000,
    sailKey: key,
    used,
    reasons,
  };
}

export function buildCorrection(entries: LogEntry[], polar: PolarTable): LearnedCorrection {
  const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const observations: PerformanceObservation[] = [];
  const exclusionReasons: Record<string, number> = {};
  for (const e of sorted) {
    if (e.kind !== "observation") continue;
    const obs = toObservation(e, polar);
    if (!obs) continue;
    observations.push(obs);
    if (!obs.used) {
      const r = (obs.reasons.find((x) => x.startsWith("excluded: ")) ?? "excluded: other").slice(10).split(" (")[0].split(" —")[0];
      exclusionReasons[r] = (exclusionReasons[r] ?? 0) + 1;
    }
  }

  const bins: CorrectionBin[] = [];
  for (let i = 0; i < TWS_EDGES.length - 1; i++) {
    for (let j = 0; j < TWA_EDGES.length - 1; j++) {
      const inBin = observations.filter(
        (o) => o.used && o.twsKn >= TWS_EDGES[i] && o.twsKn < TWS_EDGES[i + 1] && o.twaDeg >= TWA_EDGES[j] && o.twaDeg < TWA_EDGES[j + 1],
      );
      const W = inBin.reduce((s, o) => s + o.weight, 0);
      const mean = W > 0 ? inBin.reduce((s, o) => s + o.weight * o.ratio, 0) / W : 1;
      const factor = (PRIOR_STRENGTH * 1 + W * mean) / (PRIOR_STRENGTH + W);
      let stdErr: number | null = null;
      if (inBin.length >= 2 && W > 0) {
        const v = inBin.reduce((s, o) => s + o.weight * (o.ratio - mean) ** 2, 0) / W;
        const nEff = W ** 2 / inBin.reduce((s, o) => s + o.weight ** 2, 0);
        stdErr = Math.sqrt(v / nEff);
      }
      bins.push({
        twsRange: [TWS_EDGES[i], TWS_EDGES[i + 1]],
        twaRange: [TWA_EDGES[j], Math.min(180, TWA_EDGES[j + 1])],
        samples: inBin.length,
        weight: Math.round(W * 100) / 100,
        meanRatio: Math.round(mean * 1000) / 1000,
        factor: Math.round(factor * 1000) / 1000,
        stdErr: stdErr == null ? null : Math.round(stdErr * 1000) / 1000,
      });
    }
  }

  const byConfig: LearnedCorrection["byConfig"] = {};
  for (const o of observations) {
    if (!(o.ratio > 0)) continue;
    const c = (byConfig[o.sailKey] ??= { samples: 0, meanRatio: 0 });
    c.meanRatio = (c.meanRatio * c.samples + o.ratio) / (c.samples + 1);
    c.samples++;
  }
  for (const c of Object.values(byConfig)) c.meanRatio = Math.round(c.meanRatio * 1000) / 1000;

  return {
    updatedAt: new Date().toISOString(),
    priorStrength: PRIOR_STRENGTH,
    bins,
    byConfig,
    observations,
    summary: {
      considered: observations.length,
      used: observations.filter((o) => o.used).length,
      excluded: observations.filter((o) => !o.used).length,
      exclusionReasons,
    },
  };
}

export function correctionFactor(c: LearnedCorrection | null, twsKn: number, twaDeg: number): number {
  if (!c) return 1;
  const a = Math.min(180, Math.abs(twaDeg));
  const bin = c.bins.find(
    (b) => twsKn >= b.twsRange[0] && twsKn < b.twsRange[1] && a >= b.twaRange[0] && a <= b.twaRange[1],
  );
  return bin && bin.samples > 0 ? bin.factor : 1;
}
