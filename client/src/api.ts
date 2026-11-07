import type {
  CandidateRoute, DecisionRecord, EffectiveObjectives, LearnedCorrection, LogEntry, Objectives, PointWeather,
  PolarTable, RoutingResult, ServiceStatus, VesselConfig, Voyage,
} from "../../shared/types";

import type { DecisionEpisode, EvaluationResult, ImprovementRun, StrategyVersion } from "../../shared/intelligence";
export type { DecisionEpisode, EvaluationResult, ImprovementRun, StrategyVersion };
export type { CandidateRoute, DecisionRecord, EffectiveObjectives, LearnedCorrection, LogEntry, Objectives, PointWeather, RoutingResult, ServiceStatus, Voyage };

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
export interface AssistantResult { reply: string; actions: string[]; replan: boolean; via: string; modelError: string | null; entry: LogEntry | null }
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
export const ROUTE_COLORS: Record<string, string> = { R1: "#7fb7c9", R2: "#c9b98f", R3: "#9fc79a", R4: "#c79ac0", R5: "#d6d0c2", R6: "#8fa8d6" };
