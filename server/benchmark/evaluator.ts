import type { BenchmarkScenario, DecisionEpisode, EvaluationResult, MetricSet } from "../../shared/intelligence.js";
import type { EffectiveObjectives, LatLon, PolarTable, VesselConfig } from "../../shared/types.js";
import { computeRoutes } from "../routing/engine.js";
import { newId } from "../store/jsonStore.js";
import { strategies, type LoadedStrategy } from "../strategies/runtime.js";
import type { WeatherField } from "../weather/openMeteo.js";
import { dataset, predictLeg, seaBucket } from "./dataset.js";

// Benchmark evaluator — independent of the improvement agent.
// It reads ONLY the held-out split, replays identical scenarios through the production and
// candidate strategies, and decides promotion with fixed, pre-declared gates. The agent
// never sees these results while developing a candidate.

export const GATES = {
  minSpeedMaeImprovement: 0.02, // ≥ 2 % better speed MAE on all held-out scenarios
  maxEtaMaeRegression: 0.01, // ETA MAE may not get > 1 % worse
  maxBucketRegression: 0.10, // no sea-state bucket (n ≥ 5) may get > 10 % worse
  maxRealDataRegression: 0.05, // real-log held-out MAE may not get > 5 % worse (guards against overfitting synthetic data)
};

export function metricsFor(s: LoadedStrategy, scenarios: BenchmarkScenario[], polar: PolarTable): MetricSet {
  const corr = dataset.current()?.realCorrection ?? null;
  const rows = scenarios.map((sc) => {
    const p = predictLeg(s, polar, corr, sc);
    return { sc, err: p.predSogKn - sc.observedSogKn, etaErrMin: (p.predDurationH - sc.durationH) * 60 };
  });
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const r3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);
  const bySeaState: MetricSet["bySeaState"] = {};
  for (const row of rows) {
    const k = seaBucket(row.sc.weather.waveHeightM);
    const b = (bySeaState[k] ??= { n: 0, speedMAE: 0, speedBias: 0 });
    b.n++; b.speedMAE += Math.abs(row.err); b.speedBias += row.err;
  }
  for (const b of Object.values(bySeaState)) { b.speedMAE = r3(b.speedMAE / b.n)!; b.speedBias = r3(b.speedBias / b.n)!; }
  return {
    n: rows.length,
    speedMAE: r3(mean(rows.map((r) => Math.abs(r.err)))),
    speedBias: r3(mean(rows.map((r) => r.err))),
    etaMAEmin: r3(mean(rows.map((r) => Math.abs(r.etaErrMin)))),
    etaBiasMin: r3(mean(rows.map((r) => r.etaErrMin))),
    bySeaState,
  };
}

export interface CounterfactualScenario {
  name: string;
  field: WeatherField;
  start: LatLon;
  destination: LatLon;
  departureMs: number;
  objectives: EffectiveObjectives;
}

function counterfactual(s: LoadedStrategy, cf: CounterfactualScenario, polar: PolarTable, vessel: VesselConfig) {
  const r = computeRoutes({ field: cf.field, polar, correction: null, vessel, objectives: cf.objectives, departureMs: cf.departureMs, weatherFetchedAt: null, weatherStale: false, strategy: s.module, strategyVersion: s.meta.version }, cf.start, cf.destination);
  const eligible = r.routes.filter((x) => x.eligible);
  const fastest = eligible.length ? Math.min(...eligible.map((x) => x.metrics.durationHours)) : null;
  // local ranking with the strategy's own scoring (SubQ is not re-queried in counterfactuals)
  let selected: string | null = null;
  if (eligible.length) {
    const norm = (vals: number[], hi: boolean) => { const mn = Math.min(...vals), mx = Math.max(...vals); return vals.map((v) => (mx === mn ? 0.5 : hi ? (v - mn) / (mx - mn) : (mx - v) / (mx - mn))); };
    const sp = norm(eligible.map((x) => x.metrics.durationHours), false), cm = norm(eligible.map((x) => x.metrics.comfortIndex), true), fu = norm(eligible.map((x) => x.metrics.motoringHours), false), sa = norm(eligible.map((x) => x.metrics.goodSailingPct), true);
    const scores = eligible.map((_, i) => s.module.scoreRoute({ speed: sp[i], comfort: cm[i], fuel: fu[i], sailing: sa[i] }, cf.objectives.weights));
    selected = eligible[scores.indexOf(Math.max(...scores))].id;
  }
  return { violations: r.routes.reduce((n, x) => n + x.hardConstraintViolations.filter((v) => !/simulation window/.test(v)).length, 0), fastestH: fastest, selected };
}

export async function evaluate(a: {
  production: string;
  candidate: string;
  polar: PolarTable;
  vessel: VesselConfig;
  counterfactuals: CounterfactualScenario[];
  liveEpisodes: DecisionEpisode[];
}): Promise<EvaluationResult> {
  const prod = strategies.load(a.production);
  const cand = strategies.load(a.candidate);
  const held = dataset.heldout();
  const groups: Record<string, BenchmarkScenario[]> = { all: held };
  for (const s of held) (groups[s.provenance] ??= []).push(s);
  const pm: Record<string, MetricSet> = {}, cm: Record<string, MetricSet> = {};
  for (const [k, list] of Object.entries(groups)) { pm[k] = metricsFor(prod, list, a.polar); cm[k] = metricsFor(cand, list, a.polar); }

  const cfs = a.counterfactuals.map((cf) => ({ name: cf.name, production: counterfactual(prod, cf, a.polar, a.vessel), candidate: counterfactual(cand, cf, a.polar, a.vessel) }));
  const candV = cfs.reduce((n, c) => n + c.candidate.violations, 0), prodV = cfs.reduce((n, c) => n + c.production.violations, 0);

  // Comfort / preference — only where captain feedback exists (live episodes).
  const withComfort = a.liveEpisodes.filter((e) => e.feedback.some((f) => f.comfortRating != null));
  const comfortErr = withComfort.map((e) => {
    const rating = e.feedback.filter((f) => f.comfortRating != null).at(-1)!.comfortRating!;
    const pred = e.candidates.find((c) => c.id === e.prediction.routeId)?.predicted.comfortIndex;
    return pred == null ? null : Math.abs(pred - (rating - 1) * 2.5);
  }).filter((x): x is number => x != null);
  const useful = a.liveEpisodes.flatMap((e) => e.feedback.filter((f) => f.useful != null).map((f) => f.useful));

  const rel = (c: number | null, p: number | null) => (c == null || p == null || p === 0 ? 0 : (c - p) / p);
  const gates: EvaluationResult["gates"] = [];
  const dMae = rel(cm.all.speedMAE, pm.all.speedMAE);
  gates.push({ name: "Held-out speed error improves", passed: held.length > 0 && dMae <= -GATES.minSpeedMaeImprovement, detail: `MAE ${pm.all.speedMAE} → ${cm.all.speedMAE} kn (${(dMae * 100).toFixed(1)} %), need ≤ −${GATES.minSpeedMaeImprovement * 100} %` });
  const dEta = rel(cm.all.etaMAEmin, pm.all.etaMAEmin);
  gates.push({ name: "Held-out ETA error does not regress", passed: dEta <= GATES.maxEtaMaeRegression, detail: `ETA MAE ${pm.all.etaMAEmin} → ${cm.all.etaMAEmin} min (${(dEta * 100).toFixed(1)} %)` });
  const worstBucket = Object.entries(cm.all.bySeaState).filter(([k, b]) => b.n >= 5 && pm.all.bySeaState[k]).map(([k, b]) => ({ k, d: rel(b.speedMAE, pm.all.bySeaState[k].speedMAE) })).sort((x, y) => y.d - x.d)[0];
  gates.push({ name: "No sea-state regression", passed: !worstBucket || worstBucket.d <= GATES.maxBucketRegression, detail: worstBucket ? `worst bucket ${worstBucket.k}: ${(worstBucket.d * 100).toFixed(1)} % (limit +${GATES.maxBucketRegression * 100} %)` : "no buckets with n ≥ 5" });
  if (pm["historical-log"]?.n) {
    const dReal = rel(cm["historical-log"].speedMAE, pm["historical-log"].speedMAE);
    gates.push({ name: "Real-log held-out does not regress", passed: dReal <= GATES.maxRealDataRegression, detail: `real legs (n=${pm["historical-log"].n}): MAE ${pm["historical-log"].speedMAE} → ${cm["historical-log"].speedMAE} kn (${(dReal * 100).toFixed(1)} %)` });
  } else {
    gates.push({ name: "Real-log held-out does not regress", passed: true, detail: "no real held-out legs available — synthetic only" });
  }
  gates.push({ name: "No new hard-constraint violations (counterfactual)", passed: candV <= prodV, detail: cfs.length ? `${prodV} → ${candV} violations across ${cfs.length} simulated passages` : "no stored forecast available for counterfactual simulation" });

  const decision = gates.every((g) => g.passed) ? "promote" : "reject";
  const result: EvaluationResult = {
    id: newId("eval"),
    createdAt: new Date().toISOString(),
    production: a.production,
    candidate: a.candidate,
    split: "heldout",
    datasets: Object.entries(groups).filter(([k]) => k !== "all").map(([k, v]) => ({ provenance: k, n: v.length })),
    production_metrics: pm,
    candidate_metrics: cm,
    fuel: { available: false, note: "No engine fuel-burn data (vessel.json fuelBurnLph is null) and the log's diesel gauges have no units — fuel prediction error cannot be measured." },
    comfort: { n: comfortErr.length, note: comfortErr.length ? "Captain comfort ratings vs predicted comfort index of the sailed route (production predictions only — candidate would need the passage re-simulated)." : "No captain comfort feedback recorded yet.", productionMAE: comfortErr.length ? Math.round((comfortErr.reduce((x, y) => x + y, 0) / comfortErr.length) * 100) / 100 : null, candidateMAE: null },
    preference: { n: useful.length, note: useful.length ? "Share of live recommendations the captain marked useful." : "No captain usefulness feedback recorded yet.", usefulRate: useful.length ? useful.filter(Boolean).length / useful.length : null },
    counterfactual: { note: "SIMULATED counterfactuals: both strategies re-route the same stored forecast. These are model outputs, not observed outcomes.", scenarios: cfs },
    safety: { candidateViolations: candV, productionViolations: prodV },
    gates,
    decision,
    summary: decision === "promote"
      ? `Candidate ${a.candidate} passes every gate on ${held.length} held-out scenarios.`
      : `Candidate ${a.candidate} rejected — failed gates: ${gates.filter((g) => !g.passed).map((g) => g.name).join("; ")}.`,
  };
  return result;
}
