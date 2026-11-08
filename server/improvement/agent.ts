import type { BenchmarkScenario } from "../../shared/intelligence.js";
import type { PolarTable } from "../../shared/types.js";
import { dataset, predictLeg, seaBucket } from "../benchmark/dataset.js";
import { model } from "../model/provider.js";
import { compile, validate, type LoadedStrategy } from "../strategies/runtime.js";
import { hashSource } from "../strategies/runtime.js";

// Improvement agent. It works ONLY on the development split (dataset.dev()). It never calls
// the evaluator, never reads held-out results, and has no authority over hard constraints:
// it can only propose a new version of the isolated strategy module.

export interface FailureFinding {
  dimension: string;
  bucket: string;
  n: number;
  bias: number; // predicted − observed, kn (positive = over-predicts speed)
  mae: number;
  t: number;
}

export interface FailureReport {
  overall: { n: number; mae: number; bias: number; byProvenance: Record<string, { n: number; mae: number; bias: number }> };
  tables: Record<string, FailureFinding[]>;
  top: FailureFinding | null;
  text: string;
}

const twaBucket = (a: number) => (a < 70 ? "upwind <70°" : a <= 120 ? "reaching 70–120°" : "running >120°");
const twsBucket = (w: number) => (w < 10 ? "<10 kn" : w < 16 ? "10–16 kn" : w < 22 ? "16–22 kn" : "≥22 kn");
const periodBucket = (p: number | null) => (p == null ? "unknown" : p < 7 ? "short <7 s" : "long ≥7 s");

function stats(errs: number[]) {
  const n = errs.length;
  const mean = errs.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, bias: mean, mae: errs.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, n), t: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0 };
}

export function devError(s: LoadedStrategy, polar: PolarTable, scenarios = dataset.dev()) {
  const corr = dataset.current()?.realCorrection ?? null;
  const rows = scenarios.map((sc) => ({ sc, err: predictLeg(s, polar, corr, sc).predSogKn - sc.observedSogKn, twa: predictLeg(s, polar, corr, sc).courseTwa }));
  return rows;
}

/** Deterministic failure analysis — numbers come from code, not from the language model. */
export function analyseFailures(prod: LoadedStrategy, polar: PolarTable): FailureReport {
  const rows = devError(prod, polar);
  const dims: Record<string, (r: { sc: BenchmarkScenario; twa: number }) => string> = {
    "sea state": (r) => seaBucket(r.sc.weather.waveHeightM),
    "wind angle": (r) => twaBucket(r.twa),
    "wind speed": (r) => twsBucket(r.sc.weather.twsKn),
    "wave period": (r) => periodBucket(r.sc.weather.wavePeriodS),
    "sea state × wind angle": (r) => `${seaBucket(r.sc.weather.waveHeightM)} · ${twaBucket(r.twa)}`,
  };
  const tables: FailureReport["tables"] = {};
  for (const [dim, f] of Object.entries(dims)) {
    const groups = new Map<string, number[]>();
    for (const r of rows) groups.set(f(r), [...(groups.get(f(r)) ?? []), r.err]);
    tables[dim] = [...groups.entries()].map(([bucket, errs]) => ({ dimension: dim, bucket, ...stats(errs) })).map((x) => ({ ...x, bias: +x.bias.toFixed(3), mae: +x.mae.toFixed(3), t: +x.t.toFixed(1) })).sort((a, b) => a.bucket.localeCompare(b.bucket));
  }
  const all = stats(rows.map((r) => r.err));
  const byProvenance: FailureReport["overall"]["byProvenance"] = {};
  for (const p of new Set(rows.map((r) => r.sc.provenance))) { const s = stats(rows.filter((r) => r.sc.provenance === p).map((r) => r.err)); byProvenance[p] = { n: s.n, mae: +s.mae.toFixed(3), bias: +s.bias.toFixed(3) }; }
  const candidates = Object.values(tables).flat().filter((x) => x.n >= 8 && Math.abs(x.t) >= 3);
  const top = candidates.sort((a, b) => Math.abs(b.bias) * Math.sqrt(b.n) - Math.abs(a.bias) * Math.sqrt(a.n))[0] ?? null;
  const seaRows = tables["sea state"].map((x) => `${x.bucket}: bias ${x.bias >= 0 ? "+" : ""}${x.bias} kn, MAE ${x.mae}, n=${x.n}`).join("; ");
  const text = top
    ? `Recurring error: the production strategy ${top.bias > 0 ? "OVER-predicts" : "under-predicts"} boat speed by ${Math.abs(top.bias).toFixed(2)} kn on average in "${top.bucket}" (${top.dimension}, n=${top.n}, t=${top.t}). By sea state: ${seaRows}.`
    : `No statistically significant recurring error (|t| ≥ 3, n ≥ 8) found on the development set. By sea state: ${seaRows}.`;
  return { overall: { n: all.n, mae: +all.mae.toFixed(3), bias: +all.bias.toFixed(3), byProvenance }, tables, top, text };
}

const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "hypothesis", "changeSummary", "targetFunctions", "source"],
  properties: {
    title: { type: "string", description: "≤ 8 words" },
    hypothesis: { type: "string", description: "the physical/engineering hypothesis explaining the recurring error" },
    changeSummary: { type: "string", description: "what changes in the code, concretely" },
    targetFunctions: { type: "array", items: { type: "string", enum: ["speedFactor", "uncertaintyFactor", "adjustWeights", "scoreRoute", "context"] } },
    source: { type: "string", description: "the COMPLETE new strategy module source" },
  },
};

const RULES = `You are the improvement agent of TACK TACK, an onboard sailing routing system. You modify an isolated routing-strategy module.
Module contract (JavaScript, evaluated in a sandbox):
- The source defines \`const strategy = { speedFactor(c), uncertaintyFactor(c), adjustWeights(w, ctx), scoreRoute(c, w), context: {...} };\` and ends with the line \`strategy;\`
- speedFactor(c): c = { twsKn, twaDeg (0..180, angle sailed), waveHeightM (number|null), wavePeriodS (number|null), waveRelDeg (0..180|null), reefed (bool) }. Returns a multiplier on polar boat speed. Must stay within [0.3, 1.3] and handle nulls.
- uncertaintyFactor(c): c = { leadHours, beyondForecast }. Returns [0.5, 1.05].
- adjustWeights(w, ctx) returns all six weights in [0, 1]. scoreRoute(c, w) returns a number.
Hard rules:
- Pure functions only. No loops (for/while/do), no require/import/process/globalThis/eval/Function/prototype/constructor, no I/O.
- Do NOT touch safety: hard constraints (wind/wave limits, deadlines, restricted areas, land) are enforced outside this module.
- Make ONE focused change that addresses the reported recurring error. Keep the other functions unchanged.
- Prefer smooth, physically plausible formulas with few parameters; avoid fitting individual data points.
- Add short comments explaining the change and the version's intent at the top.`;

export interface Proposal {
  title: string;
  hypothesis: string;
  changeSummary: string;
  targetFunctions: string[];
  source: string;
  via: string;
  attempts: { attempt: number; problems: string[]; devMae: number | null }[];
  devBefore: number;
  devAfter: number | null;
}

/** Ask the language model for a change, validate it, and check it on the DEV split only. */
export async function propose(prod: LoadedStrategy, report: FailureReport, polar: PolarTable, newVersion: string): Promise<Proposal> {
  const devBefore = report.overall.mae;
  const attempts: Proposal["attempts"] = [];
  let feedback = "";
  let bestValid: Proposal | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, via } = await model.completeJson<Omit<Proposal, "via" | "attempts" | "devBefore" | "devAfter">>(
      [
        { role: "developer", content: RULES },
        {
          role: "user",
          content: `Current production module (version ${prod.meta.version}):\n\`\`\`js\n${prod.source}\n\`\`\`\n\nFailure analysis on the DEVELOPMENT set (prediction error = predicted − observed speed made good, knots):\n${report.text}\n\nTables:\n${JSON.stringify(report.tables, null, 1)}\n\nOverall dev: ${JSON.stringify(report.overall)}\n\nWrite version ${newVersion}.${feedback}`,
        },
      ],
      { name: "strategy_proposal", schema: PROPOSAL_SCHEMA },
      { maxTokens: 12000, effort: "medium" },
    );
    let source = data.source.trim();
    if (!/strategy;\s*$/.test(source)) source += "\nstrategy;\n";
    const v = validate(source);
    let devMae: number | null = null;
    if (v.ok) {
      const loaded = { meta: { ...prod.meta, version: newVersion, sourceHash: hashSource(source) }, source, module: compile(source) };
      const errs = devError(loaded, polar);
      devMae = +(errs.reduce((a, r) => a + Math.abs(r.err), 0) / Math.max(1, errs.length)).toFixed(3);
    }
    attempts.push({ attempt, problems: v.problems.slice(0, 8), devMae });
    if (v.ok && devMae != null && devMae < devBefore) {
      return { ...data, source, via, attempts, devBefore, devAfter: devMae };
    }
    if (v.ok && devMae != null && (!bestValid || devMae < (bestValid.devAfter ?? Infinity))) bestValid = { ...data, source, via, attempts, devBefore, devAfter: devMae };
    feedback = v.ok
      ? `\n\nYour previous attempt compiled but did not reduce the development-set MAE (${devBefore} → ${devMae}). Revise the change.`
      : `\n\nYour previous attempt failed validation: ${v.problems.slice(0, 5).join("; ")}. Fix these problems.`;
  }
  // A valid but non-improving proposal is still submitted — the evaluator will reject it.
  if (bestValid) return { ...bestValid, attempts };
  const last = attempts.at(-1)!;
  throw Object.assign(new Error(`No valid improving proposal after ${attempts.length} attempts (last: ${last.problems.join("; ") || `dev MAE ${last.devMae}`})`), { attempts });
}
