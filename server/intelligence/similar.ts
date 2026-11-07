import type { DecisionEpisode } from "../../shared/intelligence.js";
import type { PolarTable } from "../../shared/types.js";
import { dataset, predictLeg } from "../benchmark/dataset.js";
import { strategies } from "../strategies/runtime.js";
import { intelligence } from "./store.js";

// Collective intelligence: retrieve past experience in similar conditions — from this
// vessel's own history and from the shared (anonymised) pool of other vessels.
//
// Performance is never transferred as absolute speed. Each experience is reduced to a
// performance RATIO relative to that vessel's own polar (observed ÷ predicted), and the
// vessel's characteristics travel with it so the reader can judge relevance.
// Synthetic scenarios are never used as decision context.

export interface SimilarExperience {
  source: string;
  provenance: "historical-log" | "live";
  vessel: { type: string; lengthFt: number | null; polarIsSample: boolean; sameVessel: boolean | "unknown" };
  when: string;
  conditions: { twsKn: number; waveHeightM: number | null; twaDeg: number | null };
  sailed: string;
  predictedSogKn: number | null; // with the baseline strategy (fixed reference for comparability)
  observedSogKn: number | null;
  performanceRatio: number | null; // observed ÷ own-polar prediction
  similarity: number; // 0..1
}

export async function findSimilar(q: { twsKn: number; waveHeightM: number | null; twaDeg?: number | null }, polar: PolarTable, k = 3): Promise<SimilarExperience[]> {
  const ref = strategies.load("1.0.0"); // fixed reference model keeps ratios comparable across versions
  const dist = (tws: number, hs: number | null, twa: number | null) =>
    Math.sqrt(((tws - q.twsKn) / 5) ** 2 + (hs != null && q.waveHeightM != null ? ((hs - q.waveHeightM) / 0.75) ** 2 : 1) + (twa != null && q.twaDeg != null ? ((twa - q.twaDeg) / 45) ** 2 : 0.25));
  const out: SimilarExperience[] = [];

  for (const sc of (dataset.current()?.scenarios ?? []).filter((s) => s.provenance === "historical-log")) {
    const p = predictLeg(ref, polar, null, sc);
    out.push({
      source: `imported logbook leg ${sc.t.slice(0, 16)}Z`,
      provenance: "historical-log",
      vessel: { type: sc.vessel.type, lengthFt: sc.vessel.lengthFt, polarIsSample: sc.vessel.polarIsSample, sameVessel: "unknown" },
      when: sc.t,
      conditions: { twsKn: sc.weather.twsKn, waveHeightM: sc.weather.waveHeightM, twaDeg: Math.round(p.courseTwa) },
      sailed: `${sc.sailKey} sail, ${sc.distanceNm} nm in ${sc.durationH} h`,
      predictedSogKn: +p.predSogKn.toFixed(2),
      observedSogKn: sc.observedSogKn,
      performanceRatio: +(sc.observedSogKn / p.predSogKn).toFixed(3),
      similarity: 1 / (1 + dist(sc.weather.twsKn, sc.weather.waveHeightM, p.courseTwa)),
    });
  }

  const shared: DecisionEpisode[] = await intelligence.listShared({ provenance: "live", limit: 500 });
  for (const e of shared) {
    const f = e.context.forecastAtStart;
    const obs = e.observations.filter((o) => (o.stwKn ?? o.sogKn) != null && o.predicted && o.engine !== true);
    if (!f?.twsKn || !obs.length) continue;
    const observed = obs.reduce((a, o) => a + (o.sogKn ?? o.stwKn ?? 0), 0) / obs.length;
    const predicted = obs.reduce((a, o) => a + o.predicted!.sogKn, 0) / obs.length;
    out.push({
      source: `shared episode (vessel ${e.vessel.vesselId.slice(0, 6)}…)`,
      provenance: "live",
      vessel: { type: e.vessel.type, lengthFt: e.vessel.lengthFt, polarIsSample: e.vessel.polarIsSample, sameVessel: "unknown" },
      when: e.createdAt,
      conditions: { twsKn: f.twsKn, waveHeightM: f.waveHeightM, twaDeg: null },
      sailed: `route ${e.prediction.routeId ?? "?"} (${e.decision.engine})`,
      predictedSogKn: +predicted.toFixed(2),
      observedSogKn: +observed.toFixed(2),
      performanceRatio: +(observed / predicted).toFixed(3),
      similarity: 1 / (1 + dist(f.twsKn, f.waveHeightM, null)),
    });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, k).map((x) => ({ ...x, similarity: +x.similarity.toFixed(2) }));
}
