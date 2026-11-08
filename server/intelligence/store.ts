import crypto from "node:crypto";
import type { BenchmarkScenario, DecisionEpisode, EvaluationResult, ImprovementRun, SharedExperience } from "../../shared/intelligence.js";
import { Collection } from "../store/jsonStore.js";

// Intelligence database.
//
// IntelligenceStore is the storage abstraction for decision episodes, evaluations and
// improvement runs, plus a SHARED pool of anonymised episodes that several vessels can
// contribute to. The prototype uses local JSON files (works offline on board). Setting
// MONGODB_URI switches to MongoDB Atlas; a local outbox keeps episodes recorded offline
// and pushes them when connectivity returns.

export interface EpisodeQuery { vesselId?: string; provenance?: string; strategyVersion?: string; limit?: number }
export interface ExperienceQuery { twsKn?: number; waveHeightM?: number | null; limit?: number }

export interface IntelligenceStore {
  readonly kind: string;
  saveEpisode(e: DecisionEpisode): Promise<void>;
  getEpisode(id: string): Promise<DecisionEpisode | null>;
  listEpisodes(q?: EpisodeQuery): Promise<DecisionEpisode[]>;
  shareEpisode(e: DecisionEpisode): Promise<void>; // anonymised copy into the shared pool
  listShared(q?: EpisodeQuery): Promise<DecisionEpisode[]>;
  shareExperiences(list: SharedExperience[]): Promise<number>; // upsert, returns count written
  listSharedExperiences(q?: ExperienceQuery): Promise<SharedExperience[]>;
  saveEvaluation(r: EvaluationResult): Promise<void>;
  listEvaluations(): Promise<EvaluationResult[]>;
  saveRun(r: ImprovementRun): Promise<void>;
  getRun(id: string): Promise<ImprovementRun | null>;
  listRuns(): Promise<ImprovementRun[]>;
}

/** Anonymise an episode before it leaves the boat: hashed vessel id, coarse position/time, no free text. */
export function anonymise(e: DecisionEpisode): DecisionEpisode {
  const round = (v: number) => Math.round(v * 2) / 2;
  const hour = (iso: string) => iso.slice(0, 13) + ":00:00.000Z";
  return {
    ...e,
    id: `shared_${crypto.createHash("sha1").update(e.id).digest("hex").slice(0, 12)}`,
    vessel: { ...e.vessel, vesselId: crypto.createHash("sha256").update(e.vessel.vesselId).digest("hex").slice(0, 16) },
    createdAt: hour(e.createdAt),
    position: { lat: round(e.position.lat), lon: round(e.position.lon) },
    context: { ...e.context, objectives: { ...e.context.objectives, notes: [], activeTemporary: e.context.objectives.activeTemporary.map((t) => ({ ...t, text: "(redacted)" })) } },
    observations: e.observations.map((o) => ({ ...o, entryId: "", t: hour(o.t), position: o.position && { lat: round(o.position.lat), lon: round(o.position.lon) } })),
    feedback: e.feedback.map((f) => ({ ...f, notes: null })),
  };
}

/** Anonymise a real logbook leg for the shared pool. */
export function anonymiseLeg(sc: BenchmarkScenario, voyageTag: string): SharedExperience {
  const round = (v: number) => Math.round(v * 2) / 2;
  return {
    id: `exp_${crypto.createHash("sha1").update(`${sc.vessel.vesselId}|${sc.id}`).digest("hex").slice(0, 16)}`,
    provenance: "historical-log",
    contributedAt: new Date().toISOString(),
    voyageTag,
    vessel: { ...sc.vessel, vesselId: crypto.createHash("sha256").update(sc.vessel.vesselId).digest("hex").slice(0, 16) },
    t: sc.t.slice(0, 13) + ":00:00.000Z",
    from: { lat: round(sc.from.lat), lon: round(sc.from.lon) },
    to: { lat: round(sc.to.lat), lon: round(sc.to.lon) },
    durationH: sc.durationH,
    distanceNm: sc.distanceNm,
    courseDeg: Math.round(sc.courseDeg),
    observedSogKn: sc.observedSogKn,
    weather: sc.weather,
    sailKey: sc.sailKey,
  };
}

/** Coarse pre-filter around the query conditions; fine ranking happens in similar.ts. */
const nearConditions = (e: SharedExperience, q: ExperienceQuery) =>
  (q.twsKn == null || Math.abs(e.weather.twsKn - q.twsKn) <= 8) &&
  (q.waveHeightM == null || e.weather.waveHeightM == null || Math.abs(e.weather.waveHeightM - q.waveHeightM) <= 1.5);

const filterEp = (list: DecisionEpisode[], q: EpisodeQuery = {}) =>
  list
    .filter((e) => (!q.vesselId || e.vessel.vesselId === q.vesselId) && (!q.provenance || e.provenance === q.provenance) && (!q.strategyVersion || e.strategyVersion === q.strategyVersion))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, q.limit ?? 10_000);

export class LocalJsonIntelligenceStore implements IntelligenceStore {
  readonly kind = "local-json";
  private episodes = new Collection<DecisionEpisode>("episodes");
  private shared = new Collection<DecisionEpisode>("shared-episodes");
  private evals = new Collection<EvaluationResult>("evaluations");
  private runs = new Collection<ImprovementRun>("improvement-runs");
  private experiences = new Collection<SharedExperience>("shared-experiences");
  async shareExperiences(list: SharedExperience[]) { this.experiences.upsertMany(list); return list.length; }
  async listSharedExperiences(q: ExperienceQuery = {}) { return this.experiences.all().filter((e) => nearConditions(e, q)).slice(0, q.limit ?? 500); }
  async saveEpisode(e: DecisionEpisode) { this.episodes.upsert(e); }
  async getEpisode(id: string) { return this.episodes.get(id) ?? null; }
  async listEpisodes(q?: EpisodeQuery) { return filterEp(this.episodes.all(), q); }
  async shareEpisode(e: DecisionEpisode) { this.shared.upsert(anonymise(e)); }
  async listShared(q?: EpisodeQuery) { return filterEp(this.shared.all(), q); }
  async saveEvaluation(r: EvaluationResult) { this.evals.upsert(r); }
  async listEvaluations() { return [...this.evals.all()].reverse(); }
  async saveRun(r: ImprovementRun) { this.runs.upsert(r); }
  async getRun(id: string) { return this.runs.get(id) ?? null; }
  async listRuns() { return [...this.runs.all()].reverse(); }
}

/**
 * MongoDB Atlas adapter (collections: episodes, shared_episodes, shared_experiences, evaluations).
 * Writes go to the local store first, so the boat never depends on the shore connection;
 * shared-pool reads come from Atlas so experiences from other vessels are visible.
 */
export class MongoIntelligenceStore implements IntelligenceStore {
  readonly kind = "mongodb-atlas";
  private db: Promise<import("mongodb").Db>;
  constructor(uri: string, dbName: string, private local: LocalJsonIntelligenceStore) {
    this.db = import("mongodb").then(async ({ MongoClient }) => {
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      const db = client.db(dbName);
      await db.collection("shared_episodes").createIndex({ "context.forecastAtStart.twsKn": 1, "context.forecastAtStart.waveHeightM": 1 });
      await db.collection("episodes").createIndex({ "vessel.vesselId": 1, createdAt: -1 });
      await db.collection("shared_experiences").createIndex({ "weather.twsKn": 1, "weather.waveHeightM": 1 });
      return db;
    });
  }
  private async col(name: string) { return (await this.db).collection<any>(name); }
  async saveEpisode(e: DecisionEpisode) { await this.local.saveEpisode(e); await (await this.col("episodes")).replaceOne({ id: e.id }, e, { upsert: true }); }
  async getEpisode(id: string) { return (await this.local.getEpisode(id)) ?? ((await (await this.col("episodes")).findOne({ id }, { projection: { _id: 0 } })) as DecisionEpisode | null); }
  async listEpisodes(q?: EpisodeQuery) { return this.local.listEpisodes(q); }
  async shareEpisode(e: DecisionEpisode) { const a = anonymise(e); await this.local.shareEpisode(e); await (await this.col("shared_episodes")).replaceOne({ id: a.id }, a, { upsert: true }); }
  async listShared(q: EpisodeQuery = {}) {
    const f: Record<string, unknown> = {};
    if (q.vesselId) f["vessel.vesselId"] = q.vesselId;
    if (q.provenance) f.provenance = q.provenance;
    return (await (await this.col("shared_episodes")).find(f, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(q.limit ?? 500).toArray()) as DecisionEpisode[];
  }
  async shareExperiences(list: SharedExperience[]) {
    await this.local.shareExperiences(list);
    if (!list.length) return 0;
    await (await this.col("shared_experiences")).bulkWrite(list.map((e) => ({ replaceOne: { filter: { id: e.id }, replacement: e, upsert: true } })));
    return list.length;
  }
  async listSharedExperiences(q: ExperienceQuery = {}) {
    // Range query on the indexed condition fields — this is where the shared database earns its keep.
    const f: Record<string, unknown> = {};
    if (q.twsKn != null) f["weather.twsKn"] = { $gte: q.twsKn - 8, $lte: q.twsKn + 8 };
    if (q.waveHeightM != null) f.$or = [{ "weather.waveHeightM": { $gte: q.waveHeightM - 1.5, $lte: q.waveHeightM + 1.5 } }, { "weather.waveHeightM": null }];
    return (await (await this.col("shared_experiences")).find(f, { projection: { _id: 0 } }).limit(q.limit ?? 500).toArray()) as SharedExperience[];
  }
  async saveEvaluation(r: EvaluationResult) { await this.local.saveEvaluation(r); await (await this.col("evaluations")).replaceOne({ id: r.id }, r, { upsert: true }); }
  async listEvaluations() { return this.local.listEvaluations(); }
  async saveRun(r: ImprovementRun) { await this.local.saveRun(r); }
  async getRun(id: string) { return this.local.getRun(id); }
  async listRuns() { return this.local.listRuns(); }
}

const local = new LocalJsonIntelligenceStore();
export const intelligence: IntelligenceStore = process.env.MONGODB_URI
  ? new MongoIntelligenceStore(process.env.MONGODB_URI, process.env.MONGODB_DB ?? "tack", local)
  : local;
