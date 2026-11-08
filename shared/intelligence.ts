// Types for the self-improvement subsystem: decision episodes, strategy versions,
// benchmark evaluations and improvement runs.

import type { EffectiveObjectives, LatLon, PointWeather } from "./types.js";

export type Provenance = "live" | "historical-log" | "synthetic";

export interface VesselProfile {
  vesselId: string; // stable id; anonymised (hashed) when shared
  type: string;
  lengthFt: number | null;
  polarSource: string;
  polarIsSample: boolean;
}

/* ───────────── Decision episodes (Voyage Recorder) ───────────── */

export interface PredictedPoint {
  t: string;
  lat: number;
  lon: number;
  bspKn: number;
  sogKn: number;
  twsKn: number;
  twaDeg: number;
  waveM: number | null;
  motoring: boolean;
}

export interface EpisodeObservation {
  entryId: string;
  t: string;
  position: LatLon | null;
  sogKn: number | null;
  stwKn: number | null;
  twsKn: number | null;
  seaState: string | null;
  engine: boolean | null;
  // prediction at the same time on the selected route (kept separate from the observation)
  predicted: { sogKn: number; bspKn: number; lat: number; lon: number } | null;
  crossTrackNm: number | null;
}

export interface CaptainFeedback {
  at: string;
  useful: boolean | null; // was the recommendation useful?
  comfortRating: number | null; // 1..5 actual comfort experienced
  notes: string | null;
}

export interface DecisionEpisode {
  id: string;
  provenance: Provenance;
  createdAt: string;
  vessel: VesselProfile;
  strategyVersion: string;
  position: LatLon;
  destination: LatLon;
  context: {
    forecastAtStart: PointWeather | null; // FORECAST, not observation
    forecastRetrievedAt: string | null;
    forecastGridId: string | null; // allows counterfactual re-simulation under identical weather
    forecastStale: boolean;
    objectives: EffectiveObjectives;
  };
  candidates: {
    id: string;
    name: string;
    strategy: string;
    eligible: boolean;
    predicted: { etaIso: string | null; durationHours: number; meanSogKn: number; comfortIndex: number; motoringHours: number; maxWaveM: number | null; maxTwsKn: number };
  }[];
  decision: {
    engine: string;
    selectedRouteId: string | null;
    confidence: number | null;
    probabilities: Record<string, number>;
    captainAction: string;
    captainRouteId: string | null;
  };
  prediction: { routeId: string | null; etaIso: string | null; track: PredictedPoint[] }; // PREDICTION
  observations: EpisodeObservation[]; // ACTUAL, appended as watch reports arrive
  outcome: { arrivedAt: string | null; note: string | null }; // ACTUAL
  feedback: CaptainFeedback[];
}

/* ───────────── Strategy versions ───────────── */

export type StrategyStatus = "production" | "candidate" | "rejected" | "retired" | "invalid";

export interface StrategyVersion {
  version: string; // semver-ish: 1.0.0, 1.1.0 …
  parent: string | null;
  createdAt: string;
  author: string; // "baseline (hand-written)" | "improvement-agent (muse-spark-1.3)" | "captain rollback"
  status: StrategyStatus;
  title: string;
  hypothesis: string | null;
  changeSummary: string | null;
  file: string; // module source file (data/strategies/<version>.js)
  sourceHash: string;
  promotedAt: string | null;
  retiredAt: string | null;
  evaluationId: string | null;
  runId: string | null;
}

/* ───────────── Benchmark ───────────── */

export interface BenchmarkScenario {
  id: string;
  provenance: "historical-log" | "synthetic";
  split: "dev" | "heldout";
  vessel: VesselProfile;
  t: string;
  from: LatLon;
  to: LatLon;
  durationH: number; // ACTUAL elapsed time for the leg
  distanceNm: number; // ACTUAL distance made good
  courseDeg: number;
  observedSogKn: number; // ACTUAL
  weather: { // forecast/hindcast at leg midpoint & mid-time (NOT an observation)
    source: string;
    twsKn: number;
    twdDeg: number;
    waveHeightM: number | null;
    wavePeriodS: number | null;
    waveDirDeg: number | null;
    currentKn: number | null;
    currentDirDeg: number | null;
  };
  sailKey: string;
  notes: string[];
}

export interface MetricSet {
  n: number;
  speedMAE: number | null; // kn
  speedBias: number | null; // predicted − observed, kn
  etaMAEmin: number | null; // per-leg ETA error, minutes
  etaBiasMin: number | null;
  bySeaState: Record<string, { n: number; speedMAE: number; speedBias: number }>;
}

export interface EvaluationResult {
  id: string;
  createdAt: string;
  production: string;
  candidate: string;
  split: "heldout";
  datasets: { provenance: string; n: number }[];
  production_metrics: Record<string, MetricSet>; // keyed by provenance + "all"
  candidate_metrics: Record<string, MetricSet>;
  fuel: { available: boolean; note: string };
  comfort: { n: number; note: string; productionMAE: number | null; candidateMAE: number | null };
  preference: { n: number; note: string; usefulRate: number | null };
  counterfactual: {
    note: string;
    scenarios: { name: string; production: { violations: number; fastestH: number | null; selected: string | null }; candidate: { violations: number; fastestH: number | null; selected: string | null } }[];
  };
  safety: { candidateViolations: number; productionViolations: number };
  gates: { name: string; passed: boolean; detail: string }[];
  decision: "promote" | "reject";
  summary: string;
}

/* ───────────── Improvement runs ───────────── */

export type StageName = "dataset" | "failure" | "hypothesis" | "code" | "validation" | "version" | "evaluation" | "decision";

export interface RunStage {
  name: StageName;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
  detail: unknown;
}

export interface ImprovementRun {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  baseVersion: string;
  candidateVersion: string | null;
  status: "running" | "promoted" | "rejected" | "failed" | "no-change";
  stages: RunStage[];
  model: string | null;
  mode: "agent" | "self-test";
}

/* ───────────── Shared experience pool (collective intelligence) ───────────── */

/** An anonymised sailing leg contributed to the shared pool. Observed outcome + the archived
 *  forecast for that place and hour; positions rounded to 0.5°, time to the hour, no free text. */
export interface SharedExperience {
  id: string;
  provenance: "historical-log";
  contributedAt: string;
  voyageTag: string; // e.g. "transatlantic crossing, Apr–May 2026"
  vessel: VesselProfile; // vesselId is hashed
  t: string; // rounded to the hour
  from: LatLon; // rounded to 0.5°
  to: LatLon;
  durationH: number; // ACTUAL
  distanceNm: number; // ACTUAL
  courseDeg: number;
  observedSogKn: number; // ACTUAL
  weather: BenchmarkScenario["weather"]; // archived FORECAST, not an observation
  sailKey: string;
}
