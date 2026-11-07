import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { StrategyVersion } from "../../shared/intelligence.js";
import { config } from "../config.js";
import { readJson, writeJson } from "../store/jsonStore.js";

// Versioned routing strategies.
//
// A strategy is an isolated JavaScript module of PURE functions that the routing engine,
// the decision engine and the benchmark call. Versions live as files in data/strategies/,
// with a registry recording parentage, status and evaluation. Exactly one version is in
// production. Hard constraints (wind/wave limits, deadlines, restricted areas, land) are
// enforced by the routing engine *outside* these modules, and every module output is
// clamped by the engine — a strategy cannot switch a safety limit off.

export interface SpeedConditions {
  twsKn: number;
  twaDeg: number; // 0..180, angle actually sailed
  waveHeightM: number | null;
  wavePeriodS: number | null;
  waveRelDeg: number | null; // angle between wave direction (from) and course, 0..180
  reefed: boolean;
}
export interface Weights { speed: number; comfort: number; fuel: number; scenic: number; sailing: number; morale: number }
export interface RouteComponents { speed: number; comfort: number; fuel: number; sailing: number } // normalised 0..1, higher = better

export interface StrategyModule {
  /** Multiplier on (polar × learned correction) boat speed for sea state and conditions. */
  speedFactor(c: SpeedConditions): number;
  /** Multiplier on predicted speed by forecast lead time (forecast-uncertainty handling). */
  uncertaintyFactor(c: { leadHours: number; beyondForecast: boolean }): number;
  /** Adjust soft objective weights (never hard constraints). */
  adjustWeights(w: Weights, ctx: { crewCondition: string | null; activeTemporary: number }): Weights;
  /** Score a route for the on-board fallback ranking. */
  scoreRoute(c: RouteComponents, w: Weights): number;
  /** Context assembly for SubQ Snap. */
  context: { similarEpisodes: number; includeNext12h: boolean; includeLearnedCorrection: boolean };
}

export interface LoadedStrategy {
  meta: StrategyVersion;
  source: string;
  module: StrategyModule;
}

const DIR = path.join(config.dataDir, "strategies");
const REGISTRY = path.join(DIR, "registry.json");

export const BASELINE_SOURCE = `// TACK routing strategy module — version 1.0.0 (baseline, hand-written)
// Pure functions only: no I/O, no loops over external state. Called by the routing engine,
// the decision engine and the benchmark evaluator. Outputs are clamped by the engine.

const strategy = {
  // Vessel performance under sea state. Baseline: only penalises pounding when sailing
  // upwind (TWA < 70°) in waves above 2 m.
  speedFactor(c) {
    let f = 1;
    if (c.waveHeightM != null && c.waveHeightM > 2 && c.twaDeg < 70) {
      f *= Math.max(0.7, 1 - 0.07 * (c.waveHeightM - 2));
    }
    return f;
  },

  // Forecast uncertainty. Baseline: predictions are taken at face value.
  uncertaintyFactor(c) {
    return 1;
  },

  // Objective weighting. Baseline: the captain's weights are used unchanged.
  adjustWeights(w, ctx) {
    return w;
  },

  // Fallback route scoring (used only when SubQ is unreachable).
  scoreRoute(c, w) {
    return w.speed * c.speed + w.comfort * c.comfort + w.fuel * c.fuel + w.sailing * c.sailing + w.morale * (c.comfort + c.sailing) / 2;
  },

  // Context assembly for SubQ Snap.
  context: { similarEpisodes: 3, includeNext12h: true, includeLearnedCorrection: true },
};
strategy;
`;

/* ───────────── static checks & sandboxed compile ───────────── */

const FORBIDDEN: [RegExp, string][] = [
  [/\brequire\s*\(/, "require()"],
  [/\bimport\b/, "import"],
  [/\bprocess\b/, "process"],
  [/\bglobalThis\b/, "globalThis"],
  [/\beval\s*\(/, "eval()"],
  [/\bFunction\s*\(/, "Function()"],
  [/\bconstructor\b/, "constructor access"],
  [/__proto__|prototype/, "prototype access"],
  [/\bwhile\s*\(/, "while loop"],
  [/\bfor\s*\(/, "for loop"],
  [/\bdo\s*\{/, "do loop"],
  [/\bfetch\b|\bXMLHttpRequest\b|\bsetTimeout\b|\bsetInterval\b/, "I/O or timers"],
];

export function staticCheck(source: string): string[] {
  const problems = FORBIDDEN.filter(([re]) => re.test(source.replace(/\/\/.*$/gm, ""))).map(([, n]) => `forbidden construct: ${n}`);
  if (source.length > 12_000) problems.push("module too large (> 12 kB)");
  return problems;
}

export function compile(source: string): StrategyModule {
  const problems = staticCheck(source);
  if (problems.length) throw new Error(problems.join("; "));
  const sandbox = vm.createContext({ Math: Object.freeze(Math), Number, isFinite, Infinity, NaN });
  const mod = vm.runInContext(source, sandbox, { timeout: 100, filename: "strategy.js" }) as StrategyModule;
  for (const fn of ["speedFactor", "uncertaintyFactor", "adjustWeights", "scoreRoute"] as const) {
    if (typeof mod?.[fn] !== "function") throw new Error(`module does not export function ${fn}`);
  }
  if (!mod.context || typeof mod.context.similarEpisodes !== "number") throw new Error("module.context is missing or malformed");
  return mod;
}

/** Behavioural tests every version must pass before it can even be evaluated. */
export function validate(source: string): { ok: boolean; problems: string[]; tests: number } {
  const problems: string[] = [];
  let mod: StrategyModule;
  try {
    mod = compile(source);
  } catch (e) {
    return { ok: false, problems: [(e as Error).message], tests: 0 };
  }
  // Exercise each function inside the sandbox with a timeout (catches runaway code).
  const sandbox = vm.createContext({ mod, results: [] as unknown[] });
  let tests = 0;
  const grid: SpeedConditions[] = [];
  [0, 8, 16, 25, 40].forEach((tws) => [0, 45, 90, 135, 180].forEach((twa) => [null, 0.5, 2, 3.5, 6].forEach((h) => [null, 5, 10].forEach((p) => {
    grid.push({ twsKn: tws, twaDeg: twa, waveHeightM: h, wavePeriodS: p, waveRelDeg: 90, reefed: tws > 20 });
  }))));
  try {
    vm.runInContext(`results = ${JSON.stringify(grid)}.map((c) => mod.speedFactor(c));`, sandbox, { timeout: 500 });
    const res = (sandbox as any).results as number[];
    res.forEach((v, i) => {
      tests++;
      if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`speedFactor returned ${v} for ${JSON.stringify(grid[i])}`);
      else if (v < 0.3 || v > 1.3) problems.push(`speedFactor ${v.toFixed(3)} outside [0.3, 1.3] for ${JSON.stringify(grid[i])}`);
    });
    vm.runInContext(`results = [0, 6, 24, 96, 200].flatMap((h) => [false, true].map((b) => mod.uncertaintyFactor({ leadHours: h, beyondForecast: b })));`, sandbox, { timeout: 200 });
    ((sandbox as any).results as number[]).forEach((v) => { tests++; if (!(v >= 0.5 && v <= 1.05)) problems.push(`uncertaintyFactor ${v} outside [0.5, 1.05]`); });
    vm.runInContext(`results = [mod.adjustWeights({ speed: 0.6, comfort: 0.5, fuel: 0.4, scenic: 0.1, sailing: 0.4, morale: 0.4 }, { crewCondition: "tired", activeTemporary: 1 })];`, sandbox, { timeout: 200 });
    const w = (sandbox as any).results[0];
    tests++;
    if (!w || ["speed", "comfort", "fuel", "scenic", "sailing", "morale"].some((k) => !(w[k] >= 0 && w[k] <= 1))) problems.push("adjustWeights must return all six weights in [0, 1]");
    vm.runInContext(`results = [mod.scoreRoute({ speed: 1, comfort: 0, fuel: 0, sailing: 0 }, { speed: 1, comfort: 0, fuel: 0, scenic: 0, sailing: 0, morale: 0 }), mod.scoreRoute({ speed: 0, comfort: 0, fuel: 0, sailing: 0 }, { speed: 1, comfort: 0, fuel: 0, scenic: 0, sailing: 0, morale: 0 })];`, sandbox, { timeout: 200 });
    const [hi, lo] = (sandbox as any).results as number[];
    tests++;
    if (!(Number.isFinite(hi) && Number.isFinite(lo) && hi > lo)) problems.push("scoreRoute must prefer the faster route when only speed is weighted");
    // monotonic sanity: big seas must not make the boat FASTER than flat water upwind
    tests++;
    if (mod.speedFactor({ twsKn: 16, twaDeg: 50, waveHeightM: 4, wavePeriodS: 7, waveRelDeg: 20, reefed: false }) > mod.speedFactor({ twsKn: 16, twaDeg: 50, waveHeightM: 0.5, wavePeriodS: 7, waveRelDeg: 20, reefed: false }) + 1e-9)
      problems.push("speedFactor increases speed in 4 m head seas versus flat water");
  } catch (e) {
    problems.push(`runtime error: ${(e as Error).message}`);
  }
  return { ok: problems.length === 0, problems, tests };
}

/* ───────────── registry ───────────── */

export const hashSource = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

function ensureBaseline(): StrategyVersion[] {
  fs.mkdirSync(DIR, { recursive: true });
  const reg = readJson<StrategyVersion[]>(REGISTRY, []);
  if (reg.length) return reg;
  const file = "1.0.0.js";
  fs.writeFileSync(path.join(DIR, file), BASELINE_SOURCE);
  const v: StrategyVersion = {
    version: "1.0.0", parent: null, createdAt: new Date().toISOString(), author: "baseline (hand-written)", status: "production",
    title: "Baseline", hypothesis: null, changeSummary: "Initial strategy: upwind-only wave penalty, no forecast-uncertainty handling, captain weights unchanged.",
    file, sourceHash: hashSource(BASELINE_SOURCE), promotedAt: new Date().toISOString(), retiredAt: null, evaluationId: null, runId: null,
  };
  writeJson(REGISTRY, [v]);
  return [v];
}

let cache = new Map<string, LoadedStrategy>();

export const strategies = {
  list(): StrategyVersion[] {
    return ensureBaseline();
  },
  get(version: string): StrategyVersion | undefined {
    return this.list().find((v) => v.version === version);
  },
  source(version: string): string {
    const v = this.get(version);
    if (!v) throw new Error(`Unknown strategy version ${version}`);
    return fs.readFileSync(path.join(DIR, v.file), "utf8");
  },
  load(version: string): LoadedStrategy {
    const meta = this.get(version);
    if (!meta) throw new Error(`Unknown strategy version ${version}`);
    const hit = cache.get(version);
    if (hit && hit.meta.sourceHash === meta.sourceHash) return { ...hit, meta };
    const source = this.source(version);
    if (hashSource(source) !== meta.sourceHash) throw new Error(`Strategy ${version} source does not match its registered hash — refusing to load`);
    const loaded = { meta, source, module: compile(source) };
    cache.set(version, loaded);
    return loaded;
  },
  production(): LoadedStrategy {
    const prod = this.list().find((v) => v.status === "production");
    if (!prod) throw new Error("No production strategy");
    return this.load(prod.version);
  },
  nextVersion(parent: string): string {
    const [maj, min] = parent.split(".").map(Number);
    const taken = new Set(this.list().map((v) => v.version));
    let m = min + 1;
    while (taken.has(`${maj}.${m}.0`)) m++;
    return `${maj}.${m}.0`;
  },
  /** Store a new candidate version. It is never production on creation. */
  createCandidate(input: { parent: string; source: string; title: string; hypothesis: string; changeSummary: string; author: string; runId: string }): StrategyVersion {
    const version = this.nextVersion(input.parent);
    const file = `${version}.js`;
    fs.writeFileSync(path.join(DIR, file), input.source);
    const v: StrategyVersion = {
      version, parent: input.parent, createdAt: new Date().toISOString(), author: input.author, status: "candidate",
      title: input.title, hypothesis: input.hypothesis, changeSummary: input.changeSummary, file, sourceHash: hashSource(input.source),
      promotedAt: null, retiredAt: null, evaluationId: null, runId: input.runId,
    };
    writeJson(REGISTRY, [...this.list(), v]);
    return v;
  },
  update(version: string, patch: Partial<StrategyVersion>) {
    writeJson(REGISTRY, this.list().map((v) => (v.version === version ? { ...v, ...patch } : v)));
  },
  /** Promote a version that passed evaluation; the previous production version is retired (kept for rollback). */
  promote(version: string, evaluationId: string | null) {
    const now = new Date().toISOString();
    writeJson(REGISTRY, this.list().map((v) =>
      v.version === version ? { ...v, status: "production", promotedAt: now, evaluationId: evaluationId ?? v.evaluationId }
      : v.status === "production" ? { ...v, status: "retired", retiredAt: now } : v));
  },
  /** Roll back to a previously promoted version. */
  rollback(version: string) {
    const v = this.get(version);
    if (!v || !v.promotedAt) throw new Error("Only versions that were previously promoted can be restored");
    this.promote(version, null);
  },
  resetCache() {
    cache = new Map();
  },
};
