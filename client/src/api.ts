import type {
  CandidateRoute, DecisionRecord, EffectiveObjectives, ExtractionInfo, LearnedCorrection, LogEntry, ObjectiveChange, Objectives, Observations, PointWeather,
  PolarTable, RoutingResult, ServiceStatus, VesselConfig, Voyage,
} from "../../shared/types";

import type { DecisionEpisode, EvaluationResult, ImprovementRun, StrategyVersion } from "../../shared/intelligence";
export type { DecisionEpisode, EvaluationResult, ImprovementRun, StrategyVersion };
export type { CandidateRoute, DecisionRecord, EffectiveObjectives, ExtractionInfo, LearnedCorrection, LogEntry, ObjectiveChange, Objectives, Observations, PointWeather, RoutingResult, ServiceStatus, Voyage };

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`Server returned ${res.status}: ${text.slice(0, 120)}`); }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Observed<T = unknown> { value: T; at: string; source: string; entryId: string }
export interface AppState {
  vessel: VesselConfig;
  polar: { name: string; source: string; isSample: boolean };
  voyage: Voyage;
  voyages: Voyage[];
  objectives: Objectives;
  effectiveObjectives: EffectiveObjectives;
  vesselState: {
    position: { lat: number; lon: number; source: string; at: string | null };
    observed: Record<string, Observed<any> | null>;
    forecastHere: PointWeather | null;
    eta: { routeId: string; routeName: string; etaIso: string | null; captainAccepted: boolean } | null;
  };
  routing: RoutingResult | null;
  decision: DecisionRecord | null;
}
export interface PlanStep { step: string; ok: boolean; detail: string; ms: number }
export interface PlanResult { routing: RoutingResult | null; decision: DecisionRecord | null; steps: PlanStep[]; error: string | null }
export type Workflow = "watch_change" | "update_route" | "open_logbook";
export interface AssistantResult { reply: string; actions: string[]; replan: boolean; ui: Workflow | null; via: string; modelError: string | null; entry: LogEntry | null; change: ObjectiveChange | null }
export interface Extracted { obs: Observations; info: ExtractionInfo; error?: string }
export interface GridPoint extends PointWeather { lat: number; lon: number }

export const api = {
  state: () => call<AppState>("/state"),
  status: () => call<ServiceStatus>("/status"),
  setOffline: (forced: boolean) => call<ServiceStatus>("/offline", { body: { forced } }),
  sync: () => call<{ processed: string[]; remaining: number }>("/sync", { body: {} }),
  plan: (refreshWeather?: boolean) => call<PlanResult>("/plan", { body: { refreshWeather } }),
  refreshWeather: () => call<unknown>("/weather/refresh", { body: {} }),
  grid: (t: string) => call<{ available: boolean; time: string; points: GridPoint[] }>(`/weather/grid?t=${encodeURIComponent(t)}`),
  assistant: (message: string) => call<AssistantResult>("/assistant", { body: { message } }),
  logbook: (voyage: string) => call<LogEntry[]>(`/logbook?voyage=${encodeURIComponent(voyage)}`),
  extract: (text: string) => call<Extracted>("/logbook/extract", { body: { text } }),
  readImage: (image: string) => call<Extracted>("/logbook/image", { body: { image } }),
  logObservation: (body: { observations: Partial<Observations>; source: string; method?: string; rawText?: string | null; notes?: string[] }) => call<LogEntry>("/logbook/form", { body }),
  importLog: (filename: string, content: string, year: number) => call<{ voyageId: string; imported: number; interpretation: string }>("/logbook/import", { body: { filename, content, year } }),
  polar: () => call<{ polar: PolarTable; correction: LearnedCorrection; curves: { tws: number; points: { twa: number; base: number; learned: number }[] }[] }>("/polar"),
  learning: (upTo?: string) => call<LearnedCorrection>(`/learning${upTo ? `?upTo=${encodeURIComponent(upTo)}` : ""}`),
  uploadPolar: (filename: string, content: string) => call<{ ok: boolean }>("/polar", { body: { filename, content } }),
  objectives: (body: unknown) => call<{ objectives: Objectives; effective: EffectiveObjectives }>("/objectives", { body }),
  decisionAction: (id: string, routeId: string) => call<DecisionRecord>(`/decision/${id}/action`, { body: { routeId } }),
  voyage: (body: unknown) => call<Voyage>("/voyage", { body }),
  land: () => fetch("/api/geo/land").then((r) => r.json()),
  lab: () => call<LabState>("/lab"),
  labRun: (mode: "agent" | "self-test" = "agent") => call<ImprovementRun>("/lab/run", { body: { mode } }),
  labRunGet: (id: string) => call<ImprovementRun>(`/lab/runs/${id}`),
  labSource: (v: string) => call<{ meta: StrategyVersion; source: string; validation: { ok: boolean; problems: string[]; tests: number } }>(`/lab/strategy/${v}`),
  labRollback: (version: string) => call<{ production: string }>("/lab/rollback", { body: { version } }),
  episodes: () => call<DecisionEpisode[]>("/episodes"),
  feedback: (body: { episodeId?: string | null; useful?: boolean | null; comfortRating?: number | null; notes?: string | null }) => call<DecisionEpisode>("/episodes/feedback", { body }),
};

export interface LabState {
  strategies: StrategyVersion[];
  production: string;
  runs: ImprovementRun[];
  evaluations: EvaluationResult[];
  dataset: { builtAt: string; skipped: Record<string, number>; real: { dev: number; heldout: number }; synthetic: { dev: number; heldout: number } } | null;
  gates: Record<string, number>;
  episodesByVersion: Record<string, { episodes: number; withObservations: number; feedback: number; useful: number }>;
  store: string;
  sharedEpisodes: number;
}

/** Minimal line diff (LCS) for showing strategy code changes. */
export function lineDiff(a: string, b: string): { t: " " | "-" | "+"; line: string }[] {
  const x = a.split("\n"), y = b.split("\n");
  const m = x.length, n = y.length;
  const L = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { t: " " | "-" | "+"; line: string }[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) { out.push({ t: " ", line: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: "-", line: x[i++] });
    else out.push({ t: "+", line: y[j++] });
  }
  while (i < m) out.push({ t: "-", line: x[i++] });
  while (j < n) out.push({ t: "+", line: y[j++] });
  return out;
}

/* ── formatting helpers ── */
export const fmtTime = (iso: string | null | undefined, withDate = true) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return withDate ? `${date} ${time}Z` : `${time}Z`;
};
export const fmtAge = (minutes: number | null | undefined) => {
  if (minutes == null) return "—";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 6) / 10} h`;
  return `${Math.round(minutes / 1440)} d`;
};
export const fmtLat = (v: number) => `${Math.floor(Math.abs(v))}°${((Math.abs(v) % 1) * 60).toFixed(1).padStart(4, "0")}′${v >= 0 ? "N" : "S"}`;
export const fmtLon = (v: number) => `${String(Math.floor(Math.abs(v))).padStart(3, "0")}°${((Math.abs(v) % 1) * 60).toFixed(1).padStart(4, "0")}′${v >= 0 ? "E" : "W"}`;
export const fmtDur = (h: number) => `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
export const compass = (deg: number | null | undefined) => {
  if (deg == null) return "";
  return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
};
// Restrained cartographic palette: alternatives are quiet slate tones; only the chosen route carries the accent.
export const ROUTE_COLORS: Record<string, string> = { R1: "#6f8799", R2: "#8c9a8f", R3: "#9a8f7d", R4: "#857f9c", R5: "#93a0a8", R6: "#6f9393" };
export const ACCENT = "#c2502e";

export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }) : "—");
export const fmtClock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : "—");
export const fmtPos = (p: { lat: number; lon: number }) => `${fmtLat(p.lat)}  ${fmtLon(p.lon)}`;

/** Great-circle distance in nautical miles. */
export function distanceNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
}

export function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Accepts 24.5, -45.2, "24 12.5N", "045°10.2'W", "24N". Returns decimal degrees or null. */
export function parseCoordInput(s: string, axis: "lat" | "lon"): number | null {
  const t = s.trim();
  if (!t) return null;
  const m = t.match(/^(-?\d{1,3}(?:\.\d+)?)(?:[°\s]+(\d{1,2}(?:\.\d+)?)\s*['’′]?)?\s*([NSEW])?$/i);
  if (!m) return null;
  let v = Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
  if (m[3] && /[SW]/i.test(m[3])) v = -Math.abs(v);
  const max = axis === "lat" ? 90 : 180;
  return Math.abs(v) <= max ? +v.toFixed(5) : null;
}
