import type { BenchmarkScenario, VesselProfile } from "../../shared/intelligence.js";
import type { PolarTable } from "../../shared/types.js";
import { destination } from "../routing/geo.js";
import { effectiveCourseSpeed, polarSpeed } from "../vessel/polar.js";

// SYNTHETIC scenarios for demonstrating the improvement mechanism reproducibly.
//
// These are NOT sailing observations. They are generated from a hidden "ground-truth"
// vessel response in which sea state slows the boat on every point of sail (plus extra
// pounding upwind and in short, steep seas). The baseline strategy only models the upwind
// part, so it systematically over-predicts speed in big seas.
//
// Independence: neither the improvement agent nor the evaluator imports TRUTH_* — the agent
// only ever sees dev-split scenarios (inputs + "observed" outcomes), never this function.

export const SYNTHETIC_VESSEL: VesselProfile = {
  vesselId: "synthetic-test-vessel",
  type: "SYNTHETIC test vessel (sample polar, hidden sea-state response)",
  lengthFt: 45,
  polarSource: "polars/sample-cruiser-45.csv",
  polarIsSample: true,
};

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());

/** Hidden ground truth of the synthetic vessel's response to sea state. */
function TRUTH_seaFactor(hs: number, period: number, twa: number): number {
  let f = 1;
  if (hs > 1.5) f *= 1 - 0.055 * (hs - 1.5); // general slowdown in a seaway, all angles
  if (twa < 70 && hs > 2) f *= 1 - 0.05 * (hs - 2); // extra pounding upwind
  if (period < 7 && hs > 2) f *= 0.95; // short, steep seas
  return Math.max(0.55, f);
}

export function generateSynthetic(polar: PolarTable, n = 240, seed = 20260507): BenchmarkScenario[] {
  const r = mulberry32(seed);
  const out: BenchmarkScenario[] = [];
  for (let i = 0; i < n; i++) {
    const tws = 6 + r() * 22;
    const hs = Math.max(0.3, Math.min(5.5, 0.2 + tws * 0.1 + (r() * 2.1 - 0.6)));
    const period = 5 + r() * 7;
    const courseTwa = 40 + r() * 135;
    const twd = r() * 360;
    const course = (twd + (r() < 0.5 ? courseTwa : -courseTwa) + 360) % 360;
    const truthSpeed = (w: number, a: number) => polarSpeed(polar, w, a) * TRUTH_seaFactor(hs, period, a) * (w > 25 ? 0.9 : 1);
    const eff = effectiveCourseSpeed(truthSpeed, polar, tws, courseTwa);
    const cur = r() * 0.6;
    const curDir = r() * 360;
    const along = cur * Math.cos(((curDir - course) * Math.PI) / 180);
    const sog = Math.max(0.5, eff.vmc * (1 + 0.04 * gauss(r)) + along);
    const durationH = 6;
    const from = { lat: 15 + r() * 25, lon: -60 + r() * 35 };
    const to = destination(from, course, sog * durationH);
    out.push({
      id: `syn_${String(i).padStart(4, "0")}`,
      provenance: "synthetic",
      split: "dev", // assigned by the dataset builder
      vessel: SYNTHETIC_VESSEL,
      t: new Date(Date.UTC(2026, 0, 1) + i * 6 * 3_600_000).toISOString(),
      from, to, durationH,
      distanceNm: +(sog * durationH).toFixed(2),
      courseDeg: +course.toFixed(1),
      observedSogKn: +sog.toFixed(3),
      weather: { source: "synthetic", twsKn: +tws.toFixed(1), twdDeg: +twd.toFixed(0), waveHeightM: +hs.toFixed(2), wavePeriodS: +period.toFixed(1), waveDirDeg: +twd.toFixed(0), currentKn: +cur.toFixed(2), currentDirDeg: +curDir.toFixed(0) },
      sailKey: "full",
      notes: ["SYNTHETIC — generated scenario, not a real observation"],
    });
  }
  return out;
}
