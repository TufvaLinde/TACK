import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { LogEntry, Observations } from "../shared/types.js";
import {
  addSystemEntry, bboxFor, currentPosition, decisions, getCorrection, getPolar, ingestReport, liveEntries, LIVE_ID, logbook,
  objectivesDoc, plan, routingDoc, runSync, setPolar, status, syncQueue, vessel, vesselState, voyages, weather,
} from "./app.js";
import { answer, answerOffline, interpret, interpretOffline } from "./assistant/assistant.js";
import { config } from "./config.js";
import { emptyObservations, extractFromImage, extractOffline, extractWithModel, missingFields, sanitizeObservation } from "./logbook/extract.js";
import { importDelimited, importJson, inspectDelimited, interpretRemarks, voyageFromEntries } from "./logbook/importer.js";
import { isOffline } from "./model/provider.js";
import { net } from "./net.js";
import { applyChange, defaultObjectives, effective, normaliseChange, parsePreference, parsePreferenceOffline } from "./preferences/objectives.js";
import { newId } from "./store/jsonStore.js";
import { parsePolarCsv, parsePolarJson, polarSpeed } from "./vessel/polar.js";
import { addFeedback, attachObservation, recordCaptainAction } from "./intelligence/recorder.js";
import { anonymiseLeg, intelligence } from "./intelligence/store.js";
import { findSimilar } from "./intelligence/similar.js";
import { strategies, validate } from "./strategies/runtime.js";
import { dataset, buildDataset } from "./benchmark/dataset.js";
import { GATES } from "./benchmark/evaluator.js";
import { startCycle, scheduleImprovement, historicalEntries, historicalVessel } from "./improvement/cycle.js";

const app = express();
app.use(express.json({ limit: "20mb" }));

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) => async (req: express.Request, res: express.Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out);
  } catch (e) {
    console.error(e);
    res.status(isOffline(e) ? 503 : 500).json({ error: (e as Error).message, offline: isOffline(e) });
  }
};

/* ── status & state ── */
app.get("/api/geo/land", (_req, res) => res.sendFile(path.join(config.dataDir, "geo", "land-50m.geojson")));
app.get("/api/status", wrap(() => status()));
app.post("/api/offline", wrap(async (req) => {
  net.setForcedOffline(Boolean(req.body.forced));
  addSystemEntry(req.body.forced ? "Connectivity switched OFF (simulated offline mode)." : "Simulated offline mode ended.");
  return status();
}));
app.post("/api/sync", wrap(() => runSync()));

app.get("/api/state", wrap(() => {
  const polar = getPolar();
  return {
    vessel,
    polar: { name: polar.name, source: polar.source, isSample: polar.isSample },
    voyage: voyages.get(LIVE_ID),
    voyages: voyages.all(),
    objectives: objectivesDoc.get(),
    effectiveObjectives: effective(objectivesDoc.get()),
    vesselState: vesselState(),
    routing: routingDoc.get(),
    decision: decisions.all().at(-1) ?? null,
  };
}));

app.post("/api/voyage", wrap((req) => {
  const v = voyages.get(LIVE_ID)!;
  const next = { ...v, ...(req.body.start ? { start: req.body.start } : {}), ...(req.body.destination ? { destination: req.body.destination } : {}) };
  voyages.upsert(next);
  addSystemEntry(`Voyage updated: ${next.start.label} → ${next.destination.label}`);
  return next;
}));

/* ── vessel performance ── */
app.get("/api/polar", wrap(() => {
  const p = getPolar();
  const correction = getCorrection();
  // sampled curves for drawing
  const curves = [6, 10, 14, 20].map((tws) => ({
    tws,
    points: Array.from({ length: 37 }, (_, i) => {
      const twa = i * 5;
      const base = polarSpeed(p, tws, twa);
      const bin = correction.bins.find((b) => tws >= b.twsRange[0] && tws < b.twsRange[1] && twa >= b.twaRange[0] && twa <= b.twaRange[1]);
      return { twa, base: +base.toFixed(2), learned: +(base * (bin && bin.samples ? bin.factor : 1)).toFixed(2) };
    }),
  }));
  return { polar: p, correction, curves };
}));
app.get("/api/learning", wrap((req) => getCorrection(typeof req.query.upTo === "string" ? req.query.upTo : undefined)));
app.post("/api/polar", wrap((req) => {
  const { content, filename } = req.body as { content: string; filename: string };
  const p = filename.endsWith(".json") ? parsePolarJson(content, filename, `upload:${filename}`) : parsePolarCsv(content, filename, `upload:${filename}`);
  const file = path.join(config.dataDir, "polars", path.basename(filename));
  fs.writeFileSync(file, content);
  setPolar(p);
  addSystemEntry(`Vessel polar loaded from ${filename} (${p.twa.length} angles × ${p.tws.length} wind speeds).`);
  return { ok: true, name: p.name };
}));

/* ── weather ── */
app.post("/api/weather/refresh", wrap(async () => {
  const v = voyages.get(LIVE_ID)!;
  const s = await weather.refresh(bboxFor(currentPosition(), v.destination));
  addSystemEntry(s.lastError ? `Forecast retrieval failed: ${s.lastError}` : `Forecast retrieved from Open-Meteo (${s.meta!.times.length} hourly steps to ${s.meta!.lastTime.slice(0, 16)}Z).`);
  return s;
}));
app.get("/api/weather/grid", wrap((req) => {
  const f = weather.getField();
  if (!f) return { available: false, points: [], status: weather.status() };
  const t = req.query.t ? Date.parse(String(req.query.t)) : Date.now();
  return { available: true, time: new Date(t).toISOString(), points: f.snapshot(t), status: weather.status() };
}));

/* ── planning & decisions ── */
app.post("/api/plan", wrap(async (req) => {
  const r = await plan({ refreshWeather: req.body?.refreshWeather });
  return r;
}));
app.post("/api/decision/:id/action", wrap(async (req) => {
  const d = decisions.get(req.params.id);
  if (!d) throw new Error("Decision not found");
  const routeId: string = req.body.routeId;
  const action = routeId === d.selectedRouteId ? "accepted" : "overridden";
  d.captainAction = { action, routeId, at: new Date().toISOString() };
  decisions.upsert(d);
  if (d.episodeId) await recordCaptainAction(d.episodeId, d, routingDoc.get());
  const route = routingDoc.get()?.routes.find((r) => r.id === routeId);
  logbook.upsert({
    id: newId("dec"), voyageId: LIVE_ID, kind: "decision", timestamp: d.captainAction.at!, timestampProvenance: "TACK TACK clock", recordedAt: d.captainAction.at!,
    source: "captain:action", rawText: null, observations: null, extraction: null, decision: d,
    message: action === "accepted" ? `Captain accepted ${routeId} ${route?.name ?? ""}.` : `Captain chose ${routeId} ${route?.name ?? ""} instead of the recommended ${d.selectedRouteId}.`,
  });
  return d;
}));

/* ── objectives ── */
app.get("/api/objectives", wrap(() => ({ objectives: objectivesDoc.get(), effective: effective(objectivesDoc.get()) })));
app.post("/api/objectives", wrap(async (req) => {
  if (req.body.reset) { objectivesDoc.set(defaultObjectives()); return { objectives: objectivesDoc.get(), effective: effective(objectivesDoc.get()) }; }
  if (req.body.text) {
    const text: string = req.body.text;
    let change;
    try { change = await parsePreference(text, new Date().toISOString()); }
    catch { change = parsePreferenceOffline(text); }
    recordPreference(text, change);
    return { change, objectives: objectivesDoc.get(), effective: effective(objectivesDoc.get()) };
  }
  // structured edit from the form
  const o = objectivesDoc.get();
  const next = { ...o, hard: { ...o.hard, ...(req.body.hard ?? {}) }, base: { ...o.base, ...(req.body.base ?? {}) }, updatedAt: new Date().toISOString() };
  if (req.body.clearTemporary) next.temporary = [];
  objectivesDoc.set(next);
  addSystemEntry("Objectives edited in the form.");
  return { objectives: next, effective: effective(next) };
}));

function recordPreference(text: string, change: ReturnType<typeof normaliseChange>) {
  objectivesDoc.set(applyChange(objectivesDoc.get(), change, text));
  const now = new Date().toISOString();
  logbook.upsert({
    id: newId("pref"), voyageId: LIVE_ID, kind: "preference", timestamp: now, timestampProvenance: "TACK TACK clock", recordedAt: now,
    source: "captain:nl", rawText: text, observations: null, extraction: { method: change.method, confidence: change.confidence, missingFields: [], notes: change.notes }, preference: { text, change },
  });
}

/* ── logbook ── */
app.get("/api/logbook", wrap((req) => {
  const voyageId = String(req.query.voyage ?? LIVE_ID);
  return logbook.all().filter((e) => voyageId === "all" || e.voyageId === voyageId).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}));
app.post("/api/logbook/report", wrap(async (req) => ingestReport(String(req.body.text), { timestamp: req.body.timestamp })));
// Watch change: extract without storing, so the captain can review and confirm the values first.
app.post("/api/logbook/extract", wrap(async (req) => {
  const text = String(req.body.text ?? "").trim();
  if (!text) throw new Error("Nothing to read");
  try { return await extractWithModel(text); }
  catch (e) { const r = extractOffline(text); r.info.notes.push(`Language model unavailable: ${(e as Error).message}`); return r; }
}));
app.post("/api/logbook/image", wrap(async (req) => {
  const image = String(req.body.image ?? "");
  try { return await extractFromImage(image); }
  catch (e) {
    // Never guess values from an image we could not read.
    return { obs: emptyObservations(), info: { method: "none", confidence: 0, missingFields: [], notes: [`The image could not be read: ${(e as Error).message}. Enter the values by hand instead.`] }, error: (e as Error).message };
  }
}));
const FORM_SOURCES = new Set(["captain:form", "captain:watch-nl", "captain:watch-image", "captain:watch-form"]);
app.post("/api/logbook/form", wrap(async (req) => {
  const now = new Date().toISOString();
  const o = { ...emptyObservations(), ...(req.body.observations as Observations) };
  const source = FORM_SOURCES.has(req.body.source) ? req.body.source : "captain:form";
  const entry: LogEntry = {
    id: newId("log"), voyageId: LIVE_ID, kind: "observation", timestamp: req.body.timestamp ?? now, timestampProvenance: req.body.timestamp ? "captain-supplied time" : "time of submission",
    recordedAt: now, source, rawText: req.body.rawText ?? null, observations: o,
    extraction: {
      method: req.body.method ? `${String(req.body.method)} · confirmed by captain` : "structured form",
      confidence: 0.95, missingFields: missingFields(o), notes: Array.isArray(req.body.notes) ? req.body.notes.map(String).slice(0, 10) : [],
    },
  };
  logbook.upsert(entry);
  await attachObservation(entry, voyages.get(LIVE_ID)!.destination);
  return entry;
}));
app.post("/api/logbook/import/inspect", wrap((req) => inspectDelimited(String(req.body.content))));
app.post("/api/logbook/import", wrap(async (req) => importLog(String(req.body.content), String(req.body.filename), Number(req.body.year ?? 2026), req.body.interpret !== false)));

async function importLog(content: string, filename: string, year: number, doInterpret: boolean) {
  const voyageId = `hist_${path.basename(filename).replace(/\W+/g, "_")}`;
  let entries: LogEntry[];
  let inspection = null;
  if (filename.endsWith(".json")) entries = importJson(content, filename, { voyageId });
  else ({ entries, inspection } = importDelimited(content, filename, { year, voyageId }));
  let interpretation = "skipped";
  if (doInterpret) {
    try {
      const map = await interpretRemarks(entries);
      for (const e of entries) e.interpretation = map.get(e.id) ?? null;
      interpretation = `${map.size} remarks interpreted by the language model`;
    } catch (e) {
      interpretation = `not available: ${(e as Error).message}`;
    }
  }
  logbook.removeWhere((e) => e.voyageId === voyageId);
  logbook.upsertMany(entries);
  voyages.upsert({ ...voyageFromEntries(entries, voyageId, `${path.basename(filename)} (historical)`), notes: `Imported ${entries.length} entries from ${filename}. Remarks: ${interpretation}.` });
  buildDataset(historicalEntries(), getPolar(), historicalVessel()).catch((e) => console.warn("dataset:", e.message));
  return { voyageId, imported: entries.length, inspection, interpretation };
}

/* ── captain's assistant ── */
app.post("/api/assistant", wrap(async (req) => {
  const message = String(req.body.message ?? "").trim();
  if (!message) throw new Error("Empty message");
  const now = new Date().toISOString();
  const actions: string[] = [];
  let replan = false;
  let entry: LogEntry | null = null;
  let modelOk = true;
  let it;
  try {
    it = await interpret(message, now);
  } catch (e) {
    modelOk = false;
    const off = interpretOffline(message);
    it = {
      ...off,
      observation: null,
      objectiveChange: null,
      via: "offline",
      error: (e as Error).message,
    };
  }

  // 1. Watch report → logbook
  if (it.intents.includes("log_report")) {
    const res = modelOk && it.observation ? sanitizeObservation(it.observation, it.via) : extractOffline(message);
    entry = {
      id: newId("log"), voyageId: LIVE_ID, kind: "observation", timestamp: now, timestampProvenance: "time of submission (TACK TACK clock)", recordedAt: now,
      source: "captain:assistant", rawText: message, observations: res.obs, extraction: res.info,
    };
    logbook.upsert(entry);
    await attachObservation(entry, voyages.get(LIVE_ID)!.destination);
    if (res.info.pendingModelReview) syncQueue.set([...syncQueue.get(), { id: newId("sq"), kind: "reextract", ref: entry.id, createdAt: now }]);
    const o = res.obs;
    const got = [
      o.position && `position ${o.position.lat.toFixed(3)}, ${o.position.lon.toFixed(3)}`,
      o.headingDeg != null && `heading ${o.headingDeg}°`, o.sogKn != null && `SOG ${o.sogKn} kn`, o.stwKn != null && `STW ${o.stwKn} kn`,
      o.twsKn != null && `wind ${o.twsKn} kn${o.twdDeg != null ? ` from ${o.twdDeg}°` : ""}`,
      o.sailPlan && `sails: main ${o.sailPlan.main}, headsail ${o.sailPlan.headsail}${o.sailPlan.engine ? ", engine on" : ""}`,
      o.crewCondition && `crew: ${o.crewCondition}`,
    ].filter(Boolean);
    const instrumentData = [o.position, o.headingDeg, o.sogKn, o.stwKn, o.twsKn].some((v) => v != null);
    actions.push(`Logged ${instrumentData ? "observation" : "report"} (${res.info.method}): ${got.join("; ") || "no measurements recognised"}.${instrumentData ? ` Not stated: ${res.info.missingFields.join(", ") || "none"}.` : ""}`);
    if (o.position || o.crewCondition) replan = true;
  }

  // 2. Preference → objectives
  let change = null;
  if (it.intents.includes("preference")) {
    change = modelOk && it.objectiveChange ? normaliseChange(it.objectiveChange, it.via) : parsePreferenceOffline(message);
    recordPreference(message, change);
    const tmp = change.temporary ? ` Temporary (${change.temporary.durationHours} h): ${Object.entries(change.temporary.weights).map(([k, v]) => `${k} ${v}`).join(", ")}.` : "";
    const base = Object.keys(change.baseWeights).length ? ` Priorities: ${Object.entries(change.baseWeights).map(([k, v]) => `${k} ${v}`).join(", ")}.` : "";
    const hard = Object.keys(change.hard).length ? ` Hard constraints: ${JSON.stringify(change.hard)}.` : "";
    actions.push(`Objectives updated (${change.method}): ${change.summary}.${base}${tmp}${hard}`);
    if (change.notes.length) actions.push(`Note: ${change.notes.join(" ")}`);
    if (change.clarificationNeeded) actions.push(`Question for you: ${change.clarificationNeeded}`);
    replan = true;
  }

  // 3. Question → answer from local context
  let reply = "";
  let via = it.via;
  if (it.intents.includes("question") && it.question) {
    if (modelOk) {
      const routing = routingDoc.get();
      const d = decisions.all().at(-1);
      const hist = logbook.all().filter((e) => e.voyageId !== LIVE_ID && e.kind === "observation");
      const ctx = {
        now,
        voyage: voyages.get(LIVE_ID),
        vesselState: vesselState(),
        objectives: effective(objectivesDoc.get()),
        weather: { ...weather.status(), meta: weather.status().meta && { fetchedAt: weather.status().meta!.fetchedAt, lastTime: weather.status().meta!.lastTime, sources: weather.status().meta!.sources } },
        latestDecision: d && { engine: d.engine, selected: d.selectedRouteId, confidence: d.confidence, probabilities: d.probabilities, assessments: d.assessments, askCaptain: d.askCaptain, tradeoffs: d.tradeoffs, excluded: d.excludedRoutes, captainAction: d.captainAction },
        candidateRoutes: routing?.routes.map((r) => ({ id: r.id, name: r.name, description: r.description, eligible: r.eligible, violations: r.hardConstraintViolations, metrics: r.metrics })),
        learnedPerformance: (() => { const c = getCorrection(); return { summary: c.summary, bins: c.bins.filter((b) => b.samples), byConfig: c.byConfig }; })(),
        liveLog: liveEntries().slice(-25).map((e) => ({ t: e.timestamp, kind: e.kind, text: e.rawText ?? e.message, obs: e.observations && Object.fromEntries(Object.entries(e.observations).filter(([, v]) => v != null)) })),
        historicalLog: hist.map((e) => {
          const o = e.observations!;
          return [e.timestamp.slice(0, 16), o.position ? `${o.position.lat.toFixed(2)},${o.position.lon.toFixed(2)}` : "", o.cogDeg ?? "", o.sogKn ?? "", o.twsKn ?? "", o.twdDeg ?? "", o.sailPlan?.raw ?? "", o.remarks ?? ""].join("|");
        }),
        historicalLogFormat: "time(UTC assumed)|lat,lon|COG|SOG kn|wind kn|wind from deg|sails (M main, G genoa, E engine)|remarks",
      };
      try {
        const a = await answer(it.question, ctx);
        reply = a.text;
        via = a.via;
      } catch (e) {
        reply = answerOffline(it.question, logbook.all()) + `\n\n(Offline search — language model unavailable: ${(e as Error).message})`;
        via = "offline";
      }
    } else {
      reply = answerOffline(it.question, logbook.all()) + "\n\n(Offline search over the local logbook — no language model reachable.)";
    }
  }
  // 4. Workflows the interface should open
  const ui = it.intents.includes("watch_change") ? "watch_change" : it.intents.includes("update_route") ? "update_route" : it.intents.includes("open_logbook") ? "open_logbook" : null;
  if (ui === "update_route") replan = true;
  if (!reply && !actions.length && !ui) reply = "Noted.";
  return { reply, actions, entry, change, replan, ui, via, modelError: (it as any).error ?? null };
}));

/* ── self-improvement: episodes, strategies, benchmark, improvement runs ── */
app.get("/api/episodes", wrap(async (req) => intelligence.listEpisodes({ provenance: req.query.provenance as string | undefined, limit: 50 })));
app.post("/api/episodes/feedback", wrap(async (req) => {
  const { episodeId, useful, comfortRating, notes } = req.body;
  const ep = await addFeedback(episodeId ?? null, { useful: useful ?? null, comfortRating: comfortRating ?? null, notes: notes ?? null });
  addSystemEntry(`Captain feedback on episode ${ep.id}: ${useful === true ? "useful" : useful === false ? "not useful" : "—"}${comfortRating ? `, comfort ${comfortRating}/5` : ""}${notes ? ` — “${notes}”` : ""}`);
  return ep;
}));
app.get("/api/similar", wrap(async (req) => {
  const q = { twsKn: Number(req.query.tws ?? 15), waveHeightM: req.query.hs != null && req.query.hs !== "" ? Number(req.query.hs) : null, twaDeg: req.query.twa != null && req.query.twa !== "" ? Number(req.query.twa) : null };
  return { query: q, store: intelligence.kind, results: await findSimilar(q, getPolar(), Math.min(20, Number(req.query.k ?? 8))) };
}));

/** Contribute an imported logbook's sailing legs to the shared pool (anonymised). */
app.post("/api/intelligence/share-log", wrap(async (req) => {
  const voyageId = String(req.body.voyageId ?? "hist_atlantic_csv");
  const voyage = voyages.get(voyageId);
  if (!voyage) throw new Error(`Unknown voyage ${voyageId}`);
  const ds = dataset.current() ?? (await buildDataset(historicalEntries(), getPolar(), historicalVessel()));
  const legs = ds.scenarios.filter((s) => s.provenance === "historical-log");
  if (!legs.length) throw new Error("No usable sailing legs in the imported log");
  const first = new Date(legs[0].t), last = new Date(legs.at(-1)!.t);
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  const tag = String(req.body.voyageTag ?? `transatlantic crossing, ${fmt(first)}–${fmt(last)} ${last.getUTCFullYear()}`);
  const written = await intelligence.shareExperiences(legs.map((l) => anonymiseLeg(l, tag)));
  addSystemEntry(`Shared ${written} anonymised sailing legs from “${voyage.name}” to the ${intelligence.kind} pool (positions rounded to 0.5°, times to the hour, no remarks).`);
  return { written, store: intelligence.kind, voyageTag: tag };
}));
app.get("/api/intelligence/pool", wrap(async () => {
  const exps = await intelligence.listSharedExperiences({ limit: 5000 });
  const vessels = new Map<string, { type: string; legs: number; tags: Set<string> }>();
  for (const e of exps) {
    const v = vessels.get(e.vessel.vesselId) ?? { type: e.vessel.type, legs: 0, tags: new Set<string>() };
    v.legs++; v.tags.add(e.voyageTag);
    vessels.set(e.vessel.vesselId, v);
  }
  return {
    store: intelligence.kind,
    experiences: exps.length,
    sharedEpisodes: (await intelligence.listShared({ limit: 5000 })).length,
    vessels: [...vessels.entries()].map(([id, v]) => ({ vesselId: id, type: v.type, legs: v.legs, voyages: [...v.tags] })),
    // so the UI can draw the shared legs (rounded positions) on a chart
    legs: exps.map((e) => ({ id: e.id, from: e.from, to: e.to, t: e.t, twsKn: e.weather.twsKn, waveHeightM: e.weather.waveHeightM, observedSogKn: e.observedSogKn })),
  };
}));

app.get("/api/lab", wrap(async () => {
  const ds = dataset.current();
  const count = (prov: string, split: string) => ds?.scenarios.filter((s) => s.provenance === prov && s.split === split).length ?? 0;
  const episodes = await intelligence.listEpisodes({ limit: 500 });
  const byVersion: Record<string, { episodes: number; withObservations: number; feedback: number; useful: number }> = {};
  for (const e of episodes) {
    const b = (byVersion[e.strategyVersion] ??= { episodes: 0, withObservations: 0, feedback: 0, useful: 0 });
    b.episodes++; if (e.observations.length) b.withObservations++;
    for (const f of e.feedback) { if (f.useful != null) { b.feedback++; if (f.useful) b.useful++; } }
  }
  return {
    strategies: strategies.list(),
    production: strategies.production().meta.version,
    runs: (await intelligence.listRuns()).slice(0, 20),
    evaluations: (await intelligence.listEvaluations()).slice(0, 20),
    dataset: ds ? { builtAt: ds.builtAt, skipped: ds.skipped, real: { dev: count("historical-log", "dev"), heldout: count("historical-log", "heldout") }, synthetic: { dev: count("synthetic", "dev"), heldout: count("synthetic", "heldout") } } : null,
    gates: GATES,
    episodesByVersion: byVersion,
    store: intelligence.kind,
    sharedEpisodes: (await intelligence.listShared({ limit: 1000 })).length,
  };
}));
app.get("/api/lab/strategy/:version", wrap((req) => ({ meta: strategies.get(req.params.version), source: strategies.source(req.params.version), validation: validate(strategies.source(req.params.version)) })));
app.post("/api/lab/run", wrap((req) => startCycle({ mode: req.body?.mode === "self-test" ? "self-test" : "agent" })));
app.get("/api/lab/runs/:id", wrap(async (req) => intelligence.getRun(req.params.id)));
app.post("/api/lab/rollback", wrap((req) => {
  strategies.rollback(String(req.body.version));
  addSystemEntry(`Routing strategy rolled back to ${req.body.version} by the captain.`);
  return { production: strategies.production().meta.version };
}));

/* ── static client (production build) ── */
const dist = path.join(config.root, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

// Build the benchmark/experience dataset in the background (uses cached archive weather offline).
if (historicalEntries().length) buildDataset(historicalEntries(), getPolar(), historicalVessel()).catch((e) => console.warn("dataset:", e.message));
scheduleImprovement();

app.listen(config.port, () => {
  console.log(`TACK TACK server on http://localhost:${config.port}`);
  console.log(`  model: ${config.meta.apiKey ? `Meta Model API (${config.meta.model})` : "META_API_KEY not set"} | decisions: ${config.subq.apiKey ? config.subq.model : "SUBQ_API_KEY not set"}`);
  void syncQueue;
  void decisions;
});
