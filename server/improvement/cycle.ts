import fs from "node:fs";
import path from "node:path";
import type { ImprovementRun, RunStage, StageName } from "../../shared/intelligence.js";
import { getPolar, LIVE_ID, logbook, vessel, voyages, weather, objectivesDoc, currentPosition } from "../app.js";
import { buildDataset } from "../benchmark/dataset.js";
import { evaluate, type CounterfactualScenario } from "../benchmark/evaluator.js";
import { config } from "../config.js";
import { OWN_VESSEL_ID } from "../intelligence/recorder.js";
import { intelligence } from "../intelligence/store.js";
import { model } from "../model/provider.js";
import { effective } from "../preferences/objectives.js";
import { newId } from "../store/jsonStore.js";
import { strategies } from "../strategies/runtime.js";
import { WeatherField, type WeatherGrid } from "../weather/openMeteo.js";
import { analyseFailures, devError, propose } from "./agent.js";
import { compile, validate } from "../strategies/runtime.js";

// FAILURE → HYPOTHESIS → CODE MODIFICATION → VERSIONING → HELD-OUT EVALUATION → PROMOTION / ROLLBACK

const STAGES: StageName[] = ["dataset", "failure", "hypothesis", "code", "validation", "version", "evaluation", "decision"];
let active: string | null = null;

export const historicalVessel = () => ({
  vesselId: "logbook-atlantic-2026",
  type: "Vessel of the imported 2026 Atlantic log (type not recorded)",
  lengthFt: null,
  polarSource: getPolar().source,
  polarIsSample: getPolar().isSample,
});

export const historicalEntries = () => logbook.all().filter((e) => e.voyageId.startsWith("hist_"));

function counterfactuals(): CounterfactualScenario[] {
  const out: CounterfactualScenario[] = [];
  const v = voyages.get(LIVE_ID)!;
  const field = weather.getField();
  if (field) {
    const pos = currentPosition();
    out.push({ name: `current passage (forecast ${field.grid.meta.fetchedAt.slice(0, 16)}Z)`, field, start: pos, destination: v.destination, departureMs: Math.max(Date.now(), field.t0), objectives: effective(objectivesDoc.get()) });
  }
  // an older stored forecast from a recorded episode, if one is cached
  const ids = fs.existsSync(config.cacheDir) ? fs.readdirSync(config.cacheDir).filter((f) => f.startsWith("wx_")).sort() : [];
  const older = ids.find((f) => f !== `${field?.grid.meta.id}.json`);
  if (older) {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(config.cacheDir, older), "utf8")) as WeatherGrid;
      const f = new WeatherField(g);
      out.push({ name: `stored forecast ${g.meta.fetchedAt.slice(0, 16)}Z`, field: f, start: { lat: v.start.lat, lon: v.start.lon }, destination: v.destination, departureMs: f.t0 + 3_600_000, objectives: effective(objectivesDoc.get()) });
    } catch { /* ignore unreadable cache */ }
  }
  return out;
}

/** Deliberately flawed, hand-written candidate used to prove the evaluator rejects bad changes. */
const SELF_TEST_PATCH = {
  title: "SELF-TEST: blanket sea-state slowdown",
  hypothesis: "EVALUATOR SELF-TEST (not an agent proposal): apply a flat 15 % speed reduction whenever waves exceed 1 m, regardless of height, angle or period.",
  changeSummary: "speedFactor replaced by a step function: ×0.85 for any wave height > 1 m. Deliberately crude — expected to over-correct moderate seas and be rejected.",
  speedFactor: `speedFactor(c) {
    // SELF-TEST candidate: crude step penalty (expected to fail held-out gates)
    if (c.waveHeightM != null && c.waveHeightM > 1) return 0.85;
    return 1;
  },`,
};

export async function startCycle(opts: { mode?: "agent" | "self-test" } = {}): Promise<ImprovementRun> {
  if (active) throw new Error("An improvement cycle is already running");
  const prod = strategies.production();
  const run: ImprovementRun = {
    id: newId("run"),
    createdAt: new Date().toISOString(),
    finishedAt: null,
    baseVersion: prod.meta.version,
    candidateVersion: null,
    status: "running",
    stages: STAGES.map((name) => ({ name, status: "pending", startedAt: null, finishedAt: null, summary: null, detail: null })),
    model: opts.mode === "self-test" ? null : model.primary.model,
    mode: opts.mode ?? "agent",
  };
  await intelligence.saveRun(run);
  active = run.id;
  void execute(run).finally(() => { active = null; });
  return run;
}

async function execute(run: ImprovementRun) {
  const stage = (n: StageName) => run.stages.find((s) => s.name === n)!;
  const begin = async (n: StageName) => { Object.assign(stage(n), { status: "running", startedAt: new Date().toISOString() }); await intelligence.saveRun(run); };
  const end = async (n: StageName, status: RunStage["status"], summary: string, detail?: unknown) => {
    Object.assign(stage(n), { status, summary, detail: detail ?? null, finishedAt: new Date().toISOString() });
    await intelligence.saveRun(run);
  };
  const fail = async (n: StageName, msg: string, detail?: unknown) => {
    await end(n, "failed", msg, detail);
    for (const s of run.stages) if (s.status === "pending") s.status = "skipped";
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
    await intelligence.saveRun(run);
  };

  const polar = getPolar();
  const prod = strategies.load(run.baseVersion);
  try {
    // 1. Dataset
    await begin("dataset");
    const ds = await buildDataset(historicalEntries(), polar, historicalVessel());
    const count = (prov: string, split: string) => ds.scenarios.filter((s) => s.provenance === prov && s.split === split).length;
    await end("dataset", "done",
      `${ds.scenarios.length} scenarios — real log legs: ${count("historical-log", "dev")} dev / ${count("historical-log", "heldout")} held-out; synthetic: ${count("synthetic", "dev")} dev / ${count("synthetic", "heldout")} held-out`,
      { skipped: ds.skipped, realCorrectionObservations: ds.realCorrection?.summary.used ?? 0, note: "Real legs: imported logbook + Open-Meteo archived forecast. Synthetic: generated, labelled, hidden truth model." });

    // 2. Failure analysis (dev only)
    await begin("failure");
    const report = analyseFailures(prod, polar);
    if (!report.top && run.mode === "agent") {
      await end("failure", "done", report.text, report);
      for (const s of run.stages) if (s.status === "pending") s.status = "skipped";
      run.status = "no-change";
      run.finishedAt = new Date().toISOString();
      await intelligence.saveRun(run);
      return;
    }
    await end("failure", "done", report.text, report);

    // 3+4. Hypothesis and code (language model, dev feedback only)
    await begin("hypothesis");
    const newVersion = strategies.nextVersion(prod.meta.version);
    let proposal;
    if (run.mode === "self-test") {
      const source = prod.source.replace(/speedFactor\(c\) \{[\s\S]*?\n  \},/, SELF_TEST_PATCH.speedFactor).replace(/^\/\/ TACK routing strategy module.*$/m, `// TACK routing strategy module — version ${newVersion} (EVALUATOR SELF-TEST, deliberately flawed)`);
      const v = validate(source);
      if (!v.ok) return fail("hypothesis", `self-test patch invalid: ${v.problems.join("; ")}`);
      const errs = devError({ ...prod, source, module: compile(source) }, polar);
      proposal = { title: SELF_TEST_PATCH.title, hypothesis: SELF_TEST_PATCH.hypothesis, changeSummary: SELF_TEST_PATCH.changeSummary, targetFunctions: ["speedFactor"], source, via: "hand-written self-test", attempts: [{ attempt: 1, problems: [], devMae: +(errs.reduce((a, r) => a + Math.abs(r.err), 0) / errs.length).toFixed(3) }], devBefore: report.overall.mae, devAfter: +(errs.reduce((a, r) => a + Math.abs(r.err), 0) / errs.length).toFixed(3) };
    } else {
      try {
        proposal = await propose(prod, report, polar, newVersion);
      } catch (e) {
        return fail("hypothesis", (e as Error).message, (e as any).attempts);
      }
    }
    await end("hypothesis", "done", proposal.hypothesis, { title: proposal.title, via: proposal.via, attempts: proposal.attempts });
    await begin("code");
    await end("code", "done", proposal.changeSummary, { targetFunctions: proposal.targetFunctions, before: prod.source, after: proposal.source });

    // 5. Validation
    await begin("validation");
    await end("validation", "done", `Static checks and behavioural tests passed. Development-set speed MAE ${proposal.devBefore} → ${proposal.devAfter} kn (dev only).`, { attempts: proposal.attempts });

    // 6. Version
    await begin("version");
    const v = strategies.createCandidate({ parent: prod.meta.version, source: proposal.source, title: proposal.title, hypothesis: proposal.hypothesis, changeSummary: proposal.changeSummary, author: run.mode === "self-test" ? "evaluator self-test (hand-written, deliberately flawed)" : `improvement-agent (${proposal.via})`, runId: run.id });
    run.candidateVersion = v.version;
    await end("version", "done", `Created candidate ${v.version} (parent ${prod.meta.version}, sha ${v.sourceHash}). Production is unchanged.`, v);

    // 7. Held-out evaluation (independent evaluator)
    await begin("evaluation");
    const liveEpisodes = await intelligence.listEpisodes({ vesselId: OWN_VESSEL_ID, provenance: "live" });
    const ev = await evaluate({ production: prod.meta.version, candidate: v.version, polar, vessel, counterfactuals: counterfactuals(), liveEpisodes });
    await intelligence.saveEvaluation(ev);
    strategies.update(v.version, { evaluationId: ev.id });
    await end("evaluation", "done", `Held-out: speed MAE ${ev.production_metrics.all.speedMAE} → ${ev.candidate_metrics.all.speedMAE} kn; ETA MAE ${ev.production_metrics.all.etaMAEmin} → ${ev.candidate_metrics.all.etaMAEmin} min`, ev);

    // 8. Promotion or rollback
    await begin("decision");
    if (ev.decision === "promote") {
      strategies.promote(v.version, ev.id);
      run.status = "promoted";
      await end("decision", "done", `PROMOTED ${v.version} to production. ${prod.meta.version} retired and kept for rollback.`, ev.gates);
    } else {
      strategies.update(v.version, { status: "rejected" });
      run.status = "rejected";
      await end("decision", "done", `REJECTED ${v.version}. Production stays on ${prod.meta.version}. ${ev.summary}`, ev.gates);
    }
    run.finishedAt = new Date().toISOString();
    await intelligence.saveRun(run);
  } catch (e) {
    const cur = run.stages.find((s) => s.status === "running")?.name ?? "dataset";
    await fail(cur, (e as Error).message);
  }
}

/** Periodic examination: once a day (configurable), if new episodes exist and we are online. */
export function scheduleImprovement() {
  const hours = Number(process.env.IMPROVE_INTERVAL_HOURS ?? 24);
  if (!(hours > 0)) return;
  let lastCount = -1;
  setInterval(async () => {
    try {
      const n = (await intelligence.listEpisodes({ provenance: "live" })).length;
      if (n !== lastCount && !active) {
        lastCount = n;
        await startCycle();
      }
    } catch { /* offline or already running */ }
  }, hours * 3_600_000).unref();
}
