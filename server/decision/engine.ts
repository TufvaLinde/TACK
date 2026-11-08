import type {
  CandidateRoute,
  DecisionRecord,
  EffectiveObjectives,
  LearnedCorrection,
  LogEntry,
  PolarTable,
  RoutingResult,
  VesselConfig,
  WeatherStatus,
} from "../../shared/types.js";
import { config } from "../config.js";
import { netFetch } from "../net.js";
import { newId } from "../store/jsonStore.js";
import type { WeatherField } from "../weather/openMeteo.js";
import type { LoadedStrategy } from "../strategies/runtime.js";
import type { SimilarExperience } from "../intelligence/similar.js";

/* ───────────────────────── Provider interface ───────────────────────── */

type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number };

export interface DecisionProvider {
  name: string;
  model: string;
  configured: boolean;
  evaluate(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>>;
}

export class SubQSnapProvider implements DecisionProvider {
  name = "SubQ Decisions API";
  model = config.subq.model;
  lastError: string | null = null;
  get configured() {
    return !!config.subq.apiKey;
  }
  async evaluate(state: unknown, questions: Record<string, Question>) {
    if (!this.configured) throw new Error("SUBQ_API_KEY is not set");
    const res = await netFetch(`${config.subq.baseUrl}/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.subq.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, state, questions }),
      timeoutMs: 60_000,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { const d = JSON.parse(text).detail; msg = `${d.error_type}: ${d.message}`; } catch { /* raw */ }
      this.lastError = `SubQ HTTP ${res.status} — ${msg}`;
      throw new Error(this.lastError);
    }
    this.lastError = null;
    return JSON.parse(text).answers as Record<string, Answer>;
  }
}

export const subq = new SubQSnapProvider();

/* ───────────────────────── Decision context ───────────────────────── */

export interface DecisionInputs {
  routing: RoutingResult;
  objectives: EffectiveObjectives;
  recentInstructions: string[];
  vessel: VesselConfig;
  polar: PolarTable;
  correction: LearnedCorrection | null;
  log: LogEntry[]; // recent live entries, newest last
  weather: WeatherStatus;
  field: WeatherField | null;
  strategy: LoadedStrategy;
  similar: SimilarExperience[];
}

const COMFORT_LEVELS = ["very uncomfortable", "uncomfortable", "tolerable", "comfortable", "very comfortable"];
const SUIT_LEVELS = ["unsuitable", "poor", "acceptable", "good", "excellent"];
const ARRIVAL_LEVELS = ["unacceptable", "poor", "acceptable", "good", "ideal"];

function routeSummary(r: CandidateRoute, includeNext12h = true) {
  const m = r.metrics;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    sailingStrategy: r.strategy,
    estimatedArrivalUtc: m.etaIso,
    durationHours: m.durationHours,
    distanceNm: m.distanceNm,
    meanSpeedOverGroundKn: m.meanSogKn,
    motoringHours: m.motoringHours,
    fuelLitres: m.fuelLitres ?? "unknown (no engine fuel-burn data)",
    sailingTimePct: m.sailingHoursPct,
    goodSailingConditionsPct: m.goodSailingPct,
    upwindHours: m.upwindHours,
    wind: m.wind,
    waves: m.waves,
    comfortIndex_0to10: m.comfortIndex,
    next12Hours: includeNext12h ? m.next12h : undefined,
    hoursBeyondForecastHorizon: m.hoursBeyondForecast,
    netCurrentEffectNm: m.currentGainNm,
  };
}

export function buildDecisionRequest(inp: DecisionInputs) {
  const eligible = inp.routing.routes.filter((r) => r.eligible);
  const latest = [...inp.log].reverse().find((e) => e.kind === "observation" && e.observations);
  const crew = [...inp.log].reverse().find((e) => e.observations?.crewCondition)?.observations?.crewCondition ?? null;
  const pos = inp.routing.start;
  const here = inp.field?.at(pos.lat, pos.lon, Date.now()) ?? null;
  const dataGaps: string[] = [];
  if (!crew) dataGaps.push("Crew condition not reported");
  if (inp.weather.stale) dataGaps.push(`Weather forecast is stale (retrieved ${inp.weather.ageMinutes} min ago)`);
  if (!inp.weather.meta?.marineAvailable) dataGaps.push("Marine forecast (waves/currents) unavailable");
  if (inp.polar.isSample) dataGaps.push("Vessel polar is a generic sample, not this boat's measured polar");
  if (inp.objectives.weights.scenic > 0.5) dataGaps.push("TACK TACK has no scenic/anchorage database; scenic value of routes is unknown");
  if (eligible.some((r) => r.metrics.hoursBeyondForecast > 0)) dataGaps.push("Some routes extend beyond the forecast horizon");

  const state = {
    role: "You are evaluating candidate sailing routes on behalf of a yacht captain. The captain retains final authority.",
    task: "Select the candidate route that best satisfies the captain's CURRENT objectives. All numbers are estimates from TACK TACK's routing engine (vessel polar + Open-Meteo forecast). Hard constraints are already enforced: only eligible routes are offered. Do not recalculate physics or assume weather beyond what is given.",
    nowUtc: new Date().toISOString(),
    captainObjectives: {
      hardConstraints: inp.objectives.hard,
      softPriorityWeights_0to1: inp.objectives.weights,
      activeTemporaryInstructions: inp.objectives.activeTemporary.map((t) => ({ instruction: t.text, expiresUtc: t.expiresAt, weights: t.weights })),
      recentCaptainInstructions: inp.recentInstructions.slice(-5),
      notes: inp.objectives.notes.slice(-5),
    },
    crewCondition: crew ?? "not reported",
    vessel: {
      name: inp.vessel.name,
      engineCruiseSpeedKn: inp.vessel.engine.cruiseSpeedKn,
      operationalLimits: inp.vessel.operationalLimits,
      polar: { source: inp.polar.source, isSample: inp.polar.isSample },
      learnedPerformanceCorrection: inp.correction && inp.strategy.module.context.includeLearnedCorrection
        ? {
            observationsUsed: inp.correction.summary.used,
            binsWithData: inp.correction.bins.filter((b) => b.samples > 0).map((b) => ({ twsKn: b.twsRange, twaDeg: b.twaRange, factor: b.factor, samples: b.samples })),
          }
        : "none",
    },
    currentVesselState: latest?.observations
      ? { reportedAt: latest.timestamp, source: latest.source, ...Object.fromEntries(Object.entries(latest.observations).filter(([, v]) => v != null)) }
      : { position: pos, note: "no live observation logged; configured start position" },
    weatherAtVessel_forecast: here,
    forecastMetadata: {
      source: "Open-Meteo Forecast + Marine APIs",
      retrievedUtc: inp.weather.meta?.fetchedAt ?? null,
      ageMinutes: inp.weather.ageMinutes,
      stale: inp.weather.stale,
      horizonUtc: inp.weather.meta?.lastTime ?? null,
    },
    recentLogbook: inp.log.slice(-8).map((e) => ({ t: e.timestamp, kind: e.kind, text: e.rawText ?? e.message ?? e.preference?.text ?? null })),
    candidateRoutes: eligible.map((r) => routeSummary(r, inp.strategy.module.context.includeNext12h)),
    routingStrategyVersion: inp.strategy.meta.version,
    similarPastExperience: inp.similar.length
      ? {
          note: "Past experience in similar conditions. Performance is a RATIO to each vessel's own polar (observed ÷ predicted), not an absolute speed; vessel characteristics differ and are listed. Context only — do not treat as a forecast.",
          items: inp.similar,
        }
      : "none available",
    excludedRoutes: inp.routing.routes.filter((r) => !r.eligible).map((r) => ({ id: r.id, name: r.name, reasons: r.hardConstraintViolations })),
    routingWarnings: inp.routing.warnings,
    dataGaps,
  };

  const questions: Record<string, Question> = {
    best_route: {
      type: "choice",
      instructions: "Which candidate route best satisfies the captain's current objectives, active temporary instructions and crew condition, while respecting safety?",
      criteria: Object.fromEntries(eligible.map((r) => [r.id, `${r.name}: ETA ${r.metrics.etaIso?.slice(0, 16)}Z, ${r.metrics.durationHours} h, comfort ${r.metrics.comfortIndex}/10, motoring ${r.metrics.motoringHours} h, max wind ${r.metrics.wind.maxKn} kn, max waves ${r.metrics.waves.maxM ?? "?"} m`])),
    },
    need_more_info: {
      type: "noul",
      instructions: "Is the available information insufficient to recommend a route with confidence, such that the captain should be asked for more information first?",
      criteria: { true: "important information is missing or contradictory", false: "information is sufficient to decide" },
    },
    safety_concern: {
      type: "noul",
      instructions: "Do the forecast conditions on the eligible routes raise a safety concern given the crew's reported condition?",
    },
  };
  for (const r of eligible) {
    questions[`suitability_${r.id}`] = { type: "score", instructions: `Overall suitability of route ${r.id} (${r.name}) for the captain's current objectives.`, criteria: SUIT_LEVELS };
    questions[`comfort_${r.id}`] = { type: "score", instructions: `Expected crew comfort on route ${r.id} (${r.name}), especially over the next 12 hours.`, criteria: COMFORT_LEVELS };
    questions[`arrival_${r.id}`] = { type: "score", instructions: `How acceptable is the arrival-time trade-off of route ${r.id} (${r.name}) given the captain's deadline and speed priority?`, criteria: ARRIVAL_LEVELS };
  }
  return { state, questions, eligible, dataGaps };
}

/* ───────────────────────── Decision ───────────────────────── */

function tradeoffs(sel: CandidateRoute, all: CandidateRoute[]): string[] {
  const out: string[] = [];
  for (const r of all) {
    if (r.id === sel.id) continue;
    const dh = (sel.metrics.durationHours - r.metrics.durationHours);
    const parts = [
      `${Math.abs(dh).toFixed(0)} h ${dh > 0 ? "slower" : "faster"}`,
      `comfort ${sel.metrics.comfortIndex} vs ${r.metrics.comfortIndex}`,
      `motoring ${sel.metrics.motoringHours} h vs ${r.metrics.motoringHours} h`,
    ];
    if (sel.metrics.waves.maxM != null && r.metrics.waves.maxM != null) parts.push(`max waves ${sel.metrics.waves.maxM} m vs ${r.metrics.waves.maxM} m`);
    out.push(`vs ${r.id} ${r.name}: ${parts.join(", ")}`);
  }
  return out;
}

function clarifyingQuestion(choice: { confidence: number; probabilities: Record<string, number> }, eligible: CandidateRoute[], dataGaps: string[]): string {
  const ranked = Object.entries(choice.probabilities).sort((x, y) => y[1] - x[1]).map(([id]) => eligible.find((r) => r.id === id)).filter(Boolean) as CandidateRoute[];
  const [a, b] = ranked;
  let q = `SubQ is not confident (${(choice.confidence * 100).toFixed(0)}%). `;
  if (a && b) {
    const diffs = [
      { k: "arrival time", mag: Math.abs(a.metrics.durationHours - b.metrics.durationHours) / 12, txt: `${a.name} arrives ${Math.abs(a.metrics.durationHours - b.metrics.durationHours).toFixed(0)} h ${a.metrics.durationHours < b.metrics.durationHours ? "earlier" : "later"}` },
      { k: "comfort", mag: Math.abs(a.metrics.comfortIndex - b.metrics.comfortIndex) / 0.5 + Math.abs(a.metrics.next12h.comfortIndex - b.metrics.next12h.comfortIndex) / 0.5, txt: `comfort ${a.metrics.comfortIndex} vs ${b.metrics.comfortIndex} (next 12 h: ${a.metrics.next12h.comfortIndex} vs ${b.metrics.next12h.comfortIndex})` },
      { k: "motoring", mag: Math.abs(a.metrics.motoringHours - b.metrics.motoringHours) / 8, txt: `motoring ${a.metrics.motoringHours} h vs ${b.metrics.motoringHours} h` },
      { k: "sailing conditions", mag: Math.abs(a.metrics.goodSailingPct - b.metrics.goodSailingPct) / 8, txt: `good sailing ${a.metrics.goodSailingPct}% vs ${b.metrics.goodSailingPct}%` },
    ].sort((x, y) => y.mag - x.mag);
    q += `${a.name} and ${b.name} are close: ${diffs.slice(0, 3).map((d) => d.txt).join("; ")}. `;
    q += `Which matters more right now — ${diffs[0].k} or ${diffs[1].k}?`;
  }
  const gaps = dataGaps.filter((g) => !/sample/.test(g));
  if (gaps.length) q += ` Also missing: ${gaps.join("; ")}.`;
  return q;
}

/** Transparent weighted score — used ONLY when SubQ cannot be reached, and labelled as such. */
function localScore(routes: CandidateRoute[], o: EffectiveObjectives, strategy: LoadedStrategy): Record<string, number> {
  const norm = (vals: number[], higherBetter: boolean) => {
    const min = Math.min(...vals), max = Math.max(...vals);
    return vals.map((v) => (max === min ? 0.5 : higherBetter ? (v - min) / (max - min) : (max - v) / (max - min)));
  };
  const speed = norm(routes.map((r) => r.metrics.durationHours), false);
  const comfort = norm(routes.map((r) => (r.metrics.comfortIndex + r.metrics.next12h.comfortIndex) / 2), true);
  const fuel = norm(routes.map((r) => r.metrics.motoringHours), false);
  const sailing = norm(routes.map((r) => r.metrics.goodSailingPct), true);
  const w = o.weights;
  const scores = routes.map((_, i) => {
    const v = strategy.module.scoreRoute({ speed: speed[i], comfort: comfort[i], fuel: fuel[i], sailing: sailing[i] }, w);
    return Number.isFinite(v) ? v : 0;
  });
  const exp = scores.map((s) => Math.exp(s * 4));
  const z = exp.reduce((a, b) => a + b, 0);
  return Object.fromEntries(routes.map((r, i) => [r.id, exp[i] / z]));
}

export async function decide(inp: DecisionInputs, provider: DecisionProvider = subq): Promise<DecisionRecord> {
  const { state, questions, eligible, dataGaps } = buildDecisionRequest(inp);
  const base: DecisionRecord = {
    id: newId("dec"),
    createdAt: new Date().toISOString(),
    routingId: inp.routing.id,
    engine: "none",
    selectedRouteId: null,
    confidence: null,
    probabilities: {},
    assessments: [],
    needMoreInfo: null,
    safetyConcern: null,
    lowConfidence: true,
    askCaptain: null,
    objectivesSnapshot: inp.objectives,
    weatherFetchedAt: inp.weather.meta?.fetchedAt ?? null,
    weatherStale: inp.weather.stale,
    tradeoffs: [],
    excludedRoutes: inp.routing.routes.filter((r) => !r.eligible).map((r) => ({ id: r.id, reasons: r.hardConstraintViolations })),
    error: null,
    captainAction: { action: "pending", routeId: null, at: null },
    requestSummary: { questions: Object.keys(questions), stateBytes: JSON.stringify(state).length },
    strategyVersion: inp.strategy.meta.version,
    similarEpisodesUsed: inp.similar.length,
  };

  if (eligible.length === 0) {
    return { ...base, askCaptain: "No candidate route satisfies the hard constraints. Should a constraint (deadline, wind or wave limit, restricted area) be relaxed, or should we hold position / wait for a weather window?" };
  }
  if (eligible.length === 1) {
    return { ...base, engine: "single eligible route (no decision required)", selectedRouteId: eligible[0].id, confidence: null, askCaptain: "Only one route satisfies the hard constraints — please confirm it is acceptable.", tradeoffs: tradeoffs(eligible[0], inp.routing.routes) };
  }

  try {
    const a = await provider.evaluate(state, questions);
    const choice = a.best_route as Extract<Answer, { type: "choice" }>;
    const score = (k: string) => (a[k] && a[k].type === "score" ? Math.round((a[k] as any).score * 100) / 100 : null);
    const needMore = a.need_more_info?.type === "noul" ? a.need_more_info.noul : null;
    const safety = a.safety_concern?.type === "noul" ? a.safety_concern.noul : null;
    const sel = eligible.find((r) => r.id === choice.choice) ?? null;
    const lowConfidence = (choice.confidence ?? 0) < 0.6 || (needMore ?? 0) > 0.5;
    let askCaptain: string | null = null;
    if (lowConfidence) askCaptain = clarifyingQuestion(choice, eligible, dataGaps);
    if ((safety ?? 0) > 0.5) askCaptain = (askCaptain ? askCaptain + " " : "") + "SubQ flags a possible safety concern for the crew's condition — please review wind and wave exposure before committing.";
    return {
      ...base,
      engine: provider.model,
      selectedRouteId: sel?.id ?? null,
      confidence: choice.confidence,
      probabilities: choice.probabilities,
      assessments: eligible.map((r) => ({ routeId: r.id, suitability: score(`suitability_${r.id}`), comfort: score(`comfort_${r.id}`), arrivalTradeoff: score(`arrival_${r.id}`) })),
      needMoreInfo: needMore,
      safetyConcern: safety,
      lowConfidence,
      askCaptain,
      tradeoffs: sel ? tradeoffs(sel, inp.routing.routes) : [],
    };
  } catch (e) {
    // SubQ unreachable: fall back to a transparent local score, clearly labelled.
    const probs = localScore(eligible, inp.objectives, inp.strategy);
    const bestId = Object.entries(probs).sort((x, y) => y[1] - x[1])[0][0];
    const sel = eligible.find((r) => r.id === bestId)!;
    return {
      ...base,
      engine: "local weighted score (SubQ unavailable)",
      selectedRouteId: bestId,
      confidence: null,
      probabilities: probs,
      lowConfidence: true,
      askCaptain: "SubQ could not be reached, so this ranking comes from TACK TACK's simple on-board weighted score. Treat it as provisional; TACK TACK will re-submit to SubQ when connectivity returns.",
      tradeoffs: tradeoffs(sel, inp.routing.routes),
      error: (e as Error).message,
    };
  }
}
