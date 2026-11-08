import fs from "node:fs";
import path from "node:path";
import type {
  DecisionRecord,
  LatLon,
  LearnedCorrection,
  LogEntry,
  Objectives,
  PolarTable,
  RoutingResult,
  ServiceStatus,
  VesselConfig,
  Voyage,
} from "../shared/types.js";
import { config } from "./config.js";
import { decide, subq } from "./decision/engine.js";
import { extractOffline, extractWithModel } from "./logbook/extract.js";
import { model, isOffline } from "./model/provider.js";
import { net } from "./net.js";
import { defaultObjectives, effective } from "./preferences/objectives.js";
import { computeRoutes } from "./routing/engine.js";
import { Collection, Doc, newId, readJson } from "./store/jsonStore.js";
import { buildCorrection } from "./vessel/learning.js";
import { loadPolar } from "./vessel/polar.js";
import { OpenMeteoProvider, WeatherService, type BBox } from "./weather/openMeteo.js";
import { strategies } from "./strategies/runtime.js";
import { attachObservation, recordEpisode } from "./intelligence/recorder.js";
import { findSimilar } from "./intelligence/similar.js";

// Application services. Everything is persisted locally (data/store) so the boat keeps
// working without connectivity; network-dependent steps degrade explicitly.

export const vessel: VesselConfig = readJson(path.join(config.dataDir, "vessel.json"), null as unknown as VesselConfig);
let polar: PolarTable = loadPolar(vessel.polarFile);

export const voyages = new Collection<Voyage>("voyages");
export const logbook = new Collection<LogEntry>("logbook");
export const decisions = new Collection<DecisionRecord>("decisions");
export const objectivesDoc = new Doc<Objectives>("objectives", defaultObjectives);
export const routingDoc = new Doc<RoutingResult | null>("routing-latest", () => null);
export const syncQueue = new Doc<{ id: string; kind: "reextract" | "decision"; ref: string; createdAt: string }[]>("sync-queue", () => []);
export const weather = new WeatherService(new OpenMeteoProvider());

export const LIVE_ID = "live";
if (!voyages.get(LIVE_ID)) {
  voyages.upsert({
    id: LIVE_ID,
    name: "Live passage (demo)",
    kind: "live",
    start: { lat: 33.16, lon: -45.655, label: "Demo start — position from the 2026 log, 6 May 21:00 (configurable)" },
    destination: { lat: 38.505, lon: -28.6, label: "Horta, Faial (Azores) — approach" },
    departureTime: null,
    notes: "Start and destination are configurable. Weather is live from Open-Meteo.",
  });
}

export const getPolar = () => polar;
export function setPolar(p: PolarTable) {
  polar = p;
  correctionCache = null;
}

let correctionCache: { key: string; value: LearnedCorrection } | null = null;
export function getCorrection(upTo?: string): LearnedCorrection {
  const obs = logbook.all().filter((e) => e.kind === "observation" && (!upTo || e.timestamp <= upTo));
  const key = `${polar.source}|${obs.length}|${obs.at(-1)?.id}|${upTo ?? ""}|${obs.filter((e) => e.interpretation).length}`;
  if (correctionCache?.key === key) return correctionCache.value;
  const value = buildCorrection(obs, polar);
  if (!upTo) correctionCache = { key, value };
  return value;
}

export const liveEntries = () => logbook.all().filter((e) => e.voyageId === LIVE_ID).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

export function currentPosition(): LatLon & { source: string; at: string | null } {
  const last = [...liveEntries()].reverse().find((e) => e.observations?.position);
  if (last) return { ...last.observations!.position!, source: `logbook (${last.source})`, at: last.timestamp };
  const v = voyages.get(LIVE_ID)!;
  return { lat: v.start.lat, lon: v.start.lon, source: "configured start position", at: null };
}

export function bboxFor(a: LatLon, b: LatLon): BBox {
  const margin = Math.max(3, 0.2 * Math.abs(a.lat - b.lat), 0.15 * Math.abs(a.lon - b.lon));
  return {
    south: Math.max(-80, Math.min(a.lat, b.lat) - margin),
    north: Math.min(80, Math.max(a.lat, b.lat) + margin),
    west: Math.min(a.lon, b.lon) - margin,
    east: Math.max(a.lon, b.lon) + margin,
  };
}

export function addSystemEntry(message: string): LogEntry {
  const now = new Date().toISOString();
  return logbook.upsert({
    id: newId("sys"), voyageId: LIVE_ID, kind: "system", timestamp: now, timestampProvenance: "TACK TACK clock", recordedAt: now,
    source: "tack", rawText: null, observations: null, extraction: null, message,
  });
}

/* ───────────────────────── Log ingestion ───────────────────────── */

export async function ingestReport(text: string, opts: { source?: string; timestamp?: string } = {}): Promise<LogEntry> {
  const now = new Date().toISOString();
  let res;
  try {
    res = await extractWithModel(text);
  } catch (e) {
    res = extractOffline(text);
    res.info.notes.push(`Language model unavailable: ${(e as Error).message}`);
  }
  const entry: LogEntry = {
    id: newId("log"), voyageId: LIVE_ID, kind: "observation",
    timestamp: opts.timestamp ?? now, timestampProvenance: opts.timestamp ? "captain-supplied time" : "time of submission (TACK TACK clock)",
    recordedAt: now, source: opts.source ?? "captain:nl", rawText: text, observations: res.obs, extraction: res.info,
  };
  logbook.upsert(entry);
  if (res.info.pendingModelReview) enqueue("reextract", entry.id);
  await attachObservation(entry, voyages.get(LIVE_ID)!.destination);
  return entry;
}

function enqueue(kind: "reextract" | "decision", ref: string) {
  const q = syncQueue.get();
  if (!q.some((x) => x.kind === kind && x.ref === ref)) syncQueue.set([...q, { id: newId("sq"), kind, ref, createdAt: new Date().toISOString() }]);
}

/* ───────────────────────── Planning ───────────────────────── */

export interface PlanStep { step: string; ok: boolean; detail: string; ms: number }

export async function plan(opts: { refreshWeather?: boolean; recordDecision?: boolean } = {}): Promise<{ routing: RoutingResult | null; decision: DecisionRecord | null; steps: PlanStep[]; error: string | null }> {
  const steps: PlanStep[] = [];
  const time = async <T>(step: string, fn: () => Promise<T> | T, detail: (r: T) => string): Promise<T> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      steps.push({ step, ok: true, detail: detail(r), ms: Date.now() - t0 });
      return r;
    } catch (e) {
      steps.push({ step, ok: false, detail: (e as Error).message, ms: Date.now() - t0 });
      throw e;
    }
  };
  const voyage = voyages.get(LIVE_ID)!;
  const pos = currentPosition();
  const dest = { lat: voyage.destination.lat, lon: voyage.destination.lon };
  const bbox = bboxFor(pos, dest);

  // 1. Weather
  const online = await net.isOnline();
  const wsBefore = weather.status();
  const needFetch = opts.refreshWeather !== false && (!weather.covers(bbox) || (wsBefore.ageMinutes ?? Infinity) > 60 || opts.refreshWeather === true);
  if (needFetch && online) {
    const ws = await time("Retrieve forecast", () => weather.refresh(bbox), (s) => (s.lastError ? `failed: ${s.lastError}` : `${s.meta!.lats.length * s.meta!.lons.length} grid points, ${s.meta!.times.length} hours`));
    if (ws.lastError) steps[steps.length - 1].ok = false;
  } else {
    steps.push({ step: "Retrieve forecast", ok: online || !needFetch, detail: !online ? "offline — using cached forecast" : "cached forecast is recent", ms: 0 });
  }
  const ws = weather.status();
  const field = weather.getField();
  if (!field || !weather.covers(bbox)) {
    return { routing: null, decision: null, steps, error: !field ? "No weather forecast available. Connect to the internet to retrieve one — TACK TACK will not route on invented weather." : "The cached forecast does not cover the current position and destination. Connect to retrieve a new forecast." };
  }

  // 2. Routing — with the versioned production strategy
  const strategy = strategies.production();
  const obj = effective(objectivesDoc.get());
  const crew = [...liveEntries()].reverse().find((e) => e.observations?.crewCondition)?.observations?.crewCondition ?? null;
  try {
    const adj = strategy.module.adjustWeights({ ...obj.weights }, { crewCondition: crew, activeTemporary: obj.activeTemporary.length });
    for (const k of Object.keys(obj.weights) as (keyof typeof obj.weights)[]) if (Number.isFinite(adj?.[k])) obj.weights[k] = Math.max(0, Math.min(1, adj[k])); // hard constraints are untouched
  } catch { /* strategy weighting failed — keep the captain's weights */ }
  const correction = getCorrection();
  const routing = await time(
    "Generate candidate routes",
    () => computeRoutes({ field, polar, correction, vessel, objectives: obj, departureMs: Date.now(), weatherFetchedAt: ws.meta?.fetchedAt ?? null, weatherStale: ws.stale, strategy: strategy.module, strategyVersion: strategy.meta.version }, pos, dest),
    (r) => `${r.routes.length} candidates, ${r.routes.filter((x) => x.eligible).length} satisfy hard constraints (strategy ${strategy.meta.version})`,
  );
  routingDoc.set(routing);

  // 3. Decision
  const recentInstructions = logbook.all().filter((e) => e.kind === "preference").slice(-5).map((e) => e.preference!.text);
  const here = field.at(pos.lat, pos.lon, Date.now());
  const similar = strategy.module.context.similarEpisodes > 0 && here.twsKn != null
    ? await findSimilar({ twsKn: here.twsKn, waveHeightM: here.waveHeightM }, polar, Math.min(5, strategy.module.context.similarEpisodes)).catch(() => [])
    : [];
  const decision = await time(
    "SubQ Snap decision",
    () => decide({ routing, objectives: obj, recentInstructions, vessel, polar, correction, log: liveEntries(), weather: ws, field, strategy, similar }),
    (d) => (d.error ? `fallback: ${d.error}` : `${d.engine} → ${d.selectedRouteId ?? "none"}${d.confidence != null ? ` (${(d.confidence * 100).toFixed(0)}%)` : ""}`),
  );
  if (decision.error) steps[steps.length - 1].ok = false;
  const episode = await recordEpisode({ routing, decision, vessel, polar, objectives: obj, weather: ws, field, destination: dest });
  decision.episodeId = episode.id;
  steps.push({ step: "Record decision episode", ok: true, detail: `${episode.id} (strategy ${strategy.meta.version}${similar.length ? `, ${similar.length} similar past experiences in context` : ""})`, ms: 0 });
  decisions.upsert(decision);
  if (decision.error) enqueue("decision", decision.id);

  // 4. Logbook record
  if (opts.recordDecision !== false) {
    const sel = routing.routes.find((r) => r.id === decision.selectedRouteId);
    logbook.upsert({
      id: newId("dec"), voyageId: LIVE_ID, kind: "decision", timestamp: decision.createdAt, timestampProvenance: "TACK TACK clock", recordedAt: decision.createdAt,
      source: "tack", rawText: null, observations: null, extraction: null, decision,
      message: sel
        ? `Recommended ${sel.id} ${sel.name} (${decision.engine}${decision.confidence != null ? `, confidence ${(decision.confidence * 100).toFixed(0)}%` : ""}). ETA ${sel.metrics.etaIso?.slice(0, 16).replace("T", " ")} UTC (estimate). Awaiting captain.`
        : `No route recommended. ${decision.askCaptain ?? ""}`,
    });
  }
  return { routing, decision, steps, error: null };
}

/* ───────────────────────── Sync ───────────────────────── */

export async function runSync(): Promise<{ processed: string[]; remaining: number }> {
  const processed: string[] = [];
  if (!(await net.isOnline())) return { processed, remaining: syncQueue.get().length };
  const q = syncQueue.get();
  const left: typeof q = [];
  let replan = false;
  for (const item of q) {
    try {
      if (item.kind === "reextract") {
        const e = logbook.get(item.ref);
        if (e?.rawText) {
          const prev = e.extraction;
          const res = await extractWithModel(e.rawText);
          res.info.notes.push(`Re-interpreted after reconnecting (previously ${prev?.method}).`);
          logbook.upsert({ ...e, observations: res.obs, extraction: res.info });
          processed.push(`re-interpreted log entry ${e.id}`);
        }
      } else if (item.kind === "decision") {
        replan = true;
      }
    } catch (err) {
      if (isOffline(err)) left.push(item);
      else processed.push(`failed ${item.kind} ${item.ref}: ${(err as Error).message}`);
    }
  }
  syncQueue.set(left);
  if (replan) {
    const r = await plan({ refreshWeather: true });
    processed.push(`re-planned with fresh forecast → ${r.decision?.engine ?? r.error}`);
  }
  if (processed.length) addSystemEntry(`Connectivity restored — sync: ${processed.join("; ")}`);
  return { processed, remaining: syncQueue.get().length };
}

/* ───────────────────────── Status & vessel state ───────────────────────── */

export async function status(): Promise<ServiceStatus> {
  const online = await net.isOnline();
  return {
    online,
    forcedOffline: net.forcedOffline,
    checkedAt: new Date().toISOString(),
    model: { provider: model.primary.name, model: model.primary.model, configured: model.primary.configured, lastError: model.lastError },
    decision: { provider: subq.name, model: subq.model, configured: subq.configured, lastError: subq.lastError },
    weather: weather.status(),
    pendingSync: syncQueue.get().length,
  };
}

export function vesselState() {
  const entries = liveEntries().filter((e) => e.kind === "observation" && e.observations);
  const latestOf = <K extends keyof NonNullable<LogEntry["observations"]>>(k: K) => {
    const e = [...entries].reverse().find((x) => x.observations![k] != null);
    return e ? { value: e.observations![k], at: e.timestamp, source: e.source, entryId: e.id } : null;
  };
  const pos = currentPosition();
  const routing = routingDoc.get();
  const lastDecision = decisions.all().at(-1) ?? null;
  const chosenId = lastDecision?.captainAction.routeId ?? lastDecision?.selectedRouteId ?? null;
  const chosen = routing?.routes.find((r) => r.id === chosenId) ?? null;
  const field = weather.getField();
  const fc = field ? field.at(pos.lat, pos.lon, Date.now()) : null;
  return {
    position: pos,
    observed: {
      headingDeg: latestOf("headingDeg"), cogDeg: latestOf("cogDeg"), sogKn: latestOf("sogKn"), stwKn: latestOf("stwKn"),
      twsKn: latestOf("twsKn"), twdDeg: latestOf("twdDeg"), waveHeightM: latestOf("waveHeightM"), seaState: latestOf("seaState"),
      sailPlan: latestOf("sailPlan"), crewCondition: latestOf("crewCondition"),
    },
    forecastHere: fc,
    eta: chosen ? { routeId: chosen.id, routeName: chosen.name, etaIso: chosen.metrics.etaIso, captainAccepted: lastDecision?.captainAction.action !== "pending" } : null,
  };
}

export function ensureDirs() {
  fs.mkdirSync(config.storeDir, { recursive: true });
}
