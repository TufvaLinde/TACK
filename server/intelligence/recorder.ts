import type { CaptainFeedback, DecisionEpisode, EpisodeObservation, PredictedPoint, VesselProfile } from "../../shared/intelligence.js";
import type { DecisionRecord, LatLon, LogEntry, PolarTable, RoutingResult, VesselConfig, WeatherStatus } from "../../shared/types.js";
import type { EffectiveObjectives } from "../../shared/types.js";
import { distanceNm } from "../routing/geo.js";
import { newId } from "../store/jsonStore.js";
import type { WeatherField } from "../weather/openMeteo.js";
import { intelligence } from "./store.js";

// Voyage recorder: every routing decision becomes a persistent episode. Predictions,
// forecasts, observations and outcomes are stored in separate fields and never merged.

export const OWN_VESSEL_ID = "own-vessel";

export function vesselProfile(v: VesselConfig, polar: PolarTable, vesselId = OWN_VESSEL_ID): VesselProfile {
  return { vesselId, type: v.type, lengthFt: v.lengthFt, polarSource: polar.source, polarIsSample: polar.isSample };
}

export async function recordEpisode(a: {
  routing: RoutingResult; decision: DecisionRecord; vessel: VesselConfig; polar: PolarTable;
  objectives: EffectiveObjectives; weather: WeatherStatus; field: WeatherField | null; destination: LatLon;
}): Promise<DecisionEpisode> {
  const sel = a.routing.routes.find((r) => r.id === a.decision.selectedRouteId) ?? null;
  const ep: DecisionEpisode = {
    id: newId("ep"),
    provenance: "live",
    createdAt: a.decision.createdAt,
    vessel: vesselProfile(a.vessel, a.polar),
    strategyVersion: a.routing.strategyVersion,
    position: a.routing.start,
    destination: a.destination,
    context: {
      forecastAtStart: a.field ? a.field.at(a.routing.start.lat, a.routing.start.lon, Date.parse(a.routing.departure)) : null,
      forecastRetrievedAt: a.weather.meta?.fetchedAt ?? null,
      forecastGridId: a.weather.meta?.id ?? null,
      forecastStale: a.weather.stale,
      objectives: a.objectives,
    },
    candidates: a.routing.routes.map((r) => ({
      id: r.id, name: r.name, strategy: r.strategy, eligible: r.eligible,
      predicted: { etaIso: r.metrics.etaIso, durationHours: r.metrics.durationHours, meanSogKn: r.metrics.meanSogKn, comfortIndex: r.metrics.comfortIndex, motoringHours: r.metrics.motoringHours, maxWaveM: r.metrics.waves.maxM, maxTwsKn: r.metrics.wind.maxKn },
    })),
    decision: {
      engine: a.decision.engine, selectedRouteId: a.decision.selectedRouteId, confidence: a.decision.confidence,
      probabilities: a.decision.probabilities, captainAction: a.decision.captainAction.action, captainRouteId: a.decision.captainAction.routeId,
    },
    prediction: { routeId: sel?.id ?? null, etaIso: sel?.metrics.etaIso ?? null, track: sel ? thin(sel.track) : [] },
    observations: [],
    outcome: { arrivedAt: null, note: null },
    feedback: [],
  };
  await intelligence.saveEpisode(ep);
  await intelligence.shareEpisode(ep);
  return ep;
}

function thin(track: RoutingResult["routes"][number]["track"]): PredictedPoint[] {
  return track.filter((_, i) => i % 3 === 0 || i === track.length - 1).map((p) => ({ t: p.t, lat: p.lat, lon: p.lon, bspKn: p.bspKn, sogKn: p.sogKn, twsKn: p.twsKn, twaDeg: p.twaDeg, waveM: p.waveM, motoring: p.motoring }));
}

/** The captain chose a route: the prediction we hold the system to follows the captain's choice. */
export async function recordCaptainAction(episodeId: string, decision: DecisionRecord, routing: RoutingResult | null) {
  const ep = await intelligence.getEpisode(episodeId);
  if (!ep) return;
  const r = routing?.routes.find((x) => x.id === decision.captainAction.routeId);
  ep.decision.captainAction = decision.captainAction.action;
  ep.decision.captainRouteId = decision.captainAction.routeId;
  if (r) ep.prediction = { routeId: r.id, etaIso: r.metrics.etaIso, track: thin(r.track) };
  await intelligence.saveEpisode(ep);
}

function predictedAt(track: PredictedPoint[], tMs: number) {
  if (!track.length || tMs < Date.parse(track[0].t)) return null;
  for (let i = 1; i < track.length; i++) {
    const t1 = Date.parse(track[i].t);
    if (t1 >= tMs) {
      const a = track[i - 1], b = track[i], f = (tMs - Date.parse(a.t)) / (t1 - Date.parse(a.t) || 1);
      return { sogKn: a.sogKn + (b.sogKn - a.sogKn) * f, bspKn: a.bspKn + (b.bspKn - a.bspKn) * f, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    }
  }
  return null;
}

/** Attach a live observation to the episode that was active when it was made. */
export async function attachObservation(entry: LogEntry, destination: LatLon) {
  if (entry.kind !== "observation" || !entry.observations) return;
  const eps = await intelligence.listEpisodes({ vesselId: OWN_VESSEL_ID, provenance: "live", limit: 50 });
  const ep = eps.find((e) => e.createdAt <= entry.timestamp);
  if (!ep) return;
  const o = entry.observations;
  const pred = predictedAt(ep.prediction.track, Date.parse(entry.timestamp));
  const obs: EpisodeObservation = {
    entryId: entry.id, t: entry.timestamp, position: o.position, sogKn: o.sogKn, stwKn: o.stwKn, twsKn: o.twsKn,
    seaState: o.seaState ?? entry.interpretation?.seaState ?? null, engine: o.sailPlan?.engine ?? null,
    predicted: pred, crossTrackNm: pred && o.position ? Math.round(distanceNm(o.position, pred) * 10) / 10 : null,
  };
  ep.observations = [...ep.observations.filter((x) => x.entryId !== entry.id), obs];
  if (o.position && distanceNm(o.position, destination) < 5 && !ep.outcome.arrivedAt) ep.outcome = { arrivedAt: entry.timestamp, note: "within 5 nm of destination (logged position)" };
  await intelligence.saveEpisode(ep);
}

export async function addFeedback(episodeId: string | null, fb: Omit<CaptainFeedback, "at">): Promise<DecisionEpisode> {
  const ep = episodeId ? await intelligence.getEpisode(episodeId) : (await intelligence.listEpisodes({ vesselId: OWN_VESSEL_ID, provenance: "live", limit: 1 }))[0];
  if (!ep) throw new Error("No decision episode to give feedback on yet");
  ep.feedback.push({ ...fb, at: new Date().toISOString() });
  await intelligence.saveEpisode(ep);
  return ep;
}
