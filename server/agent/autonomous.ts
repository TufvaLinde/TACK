import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { model } from "../model/provider.js";
import { Collection, newId } from "../store/jsonStore.js";

// Autonomous engineering agent (Meta Model API).
// Each run: read a daily brief → explore the codebase → edit source files → run the gates
// (type check + test suite) → commit to its own branch `agent/main` if they pass, otherwise discard.
// It works in a separate git worktree, so the running app and your branch are never touched.
// Protected files (safety, evaluator, gates, tests, secrets) are read-only to it.

const WORKTREE = path.join(config.root, ".agent-worktree");
const BRANCH = "agent/main";
const MAX_STEPS = 14;
const PROTECTED = [/^server\/benchmark\//, /^server\/strategies\/runtime\.ts$/, /^server\/tack\.test\.ts$/, /^server\/agent\//, /^server\/routing\/geo\.ts$/, /^package(-lock)?\.json$/, /^\.env/, /^data\/store\//, /^\.git/];
const WRITABLE = /^(server|client\/src|shared|data\/strategies)\//;

export interface AgentStep { n: number; thought: string; action: string; args: Record<string, unknown>; result: string }
export interface AgentRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  goal: string;
  status: "running" | "merged" | "rejected" | "no-change" | "failed";
  steps: AgentStep[];
  filesChanged: string[];
  gates: { name: string; passed: boolean; output: string }[];
  commit: string | null;
  summary: string | null;
}
export const agentRuns = new Collection<AgentRun>("agent-runs");

const sh = (cmd: string, args: string[], cwd = WORKTREE, timeout = 180_000) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e: any) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-4000) || e.message };
  }
};

function prepareWorktree() {
  if (!fs.existsSync(WORKTREE)) {
    const hasBranch = sh("git", ["rev-parse", "--verify", BRANCH], config.root).ok;
    const r = sh("git", ["worktree", "add", WORKTREE, hasBranch ? BRANCH : "-b", ...(hasBranch ? [] : [BRANCH])], config.root);
    if (!r.ok) throw new Error(`git worktree: ${r.out}`);
  }
  sh("git", ["reset", "--hard"]);
  sh("git", ["clean", "-fd"]);
  const nm = path.join(WORKTREE, "node_modules");
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(config.root, "node_modules"), nm, "dir");
  for (const f of ["data/geo", "data/polars", "data/vessel.json"]) {
    const dst = path.join(WORKTREE, f);
    if (!fs.existsSync(dst)) fs.cpSync(path.join(config.root, f), dst, { recursive: true });
  }
}

const safePath = (p: unknown) => {
  const rel = path.normalize(String(p ?? "")).replace(/^\/+/, "");
  if (rel.startsWith("..")) throw new Error("path escapes the repository");
  return rel;
};

function tool(action: string, args: Record<string, any>, changed: Set<string>): string {
  switch (action) {
    case "list_files": {
      const r = sh("git", ["ls-files", safePath(args.dir ?? ".")]);
      return r.out.split("\n").filter(Boolean).slice(0, 200).join("\n");
    }
    case "read_file": {
      const rel = safePath(args.path);
      const text = fs.readFileSync(path.join(WORKTREE, rel), "utf8");
      const from = Math.max(1, Number(args.fromLine ?? 1));
      const lines = text.split("\n");
      return lines.slice(from - 1, from - 1 + 220).map((l, i) => `${from + i}: ${l}`).join("\n") + (lines.length > from + 219 ? `\n… (${lines.length} lines total)` : "");
    }
    case "search": {
      const r = sh("git", ["grep", "-n", "-I", "--", String(args.pattern ?? "")]);
      return r.out.split("\n").slice(0, 60).join("\n") || "no matches";
    }
    case "replace_in_file": {
      const rel = safePath(args.path);
      if (PROTECTED.some((re) => re.test(rel)) || !WRITABLE.test(rel)) return `REFUSED: ${rel} is read-only for the agent`;
      const file = path.join(WORKTREE, rel);
      const text = fs.readFileSync(file, "utf8");
      const old = String(args.old ?? "");
      const count = old ? text.split(old).length - 1 : 0;
      if (count !== 1) return `ERROR: "old" must occur exactly once (found ${count})`;
      fs.writeFileSync(file, text.replace(old, String(args.new ?? "")));
      changed.add(rel);
      return `edited ${rel}`;
    }
    case "run_checks": return runGates().map((g) => `${g.name}: ${g.passed ? "PASS" : "FAIL"}\n${g.passed ? "" : g.output.slice(-1500)}`).join("\n");
    default: return `unknown action ${action}`;
  }
}

function runGates() {
  const tsc = sh("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"]);
  const test = sh("npx", ["tsx", "--test", "server/tack.test.ts"]);
  return [
    { name: "type check", passed: tsc.ok, output: tsc.out },
    { name: "test suite", passed: test.ok && /fail 0/.test(test.out), output: test.out },
  ];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["thought", "action", "args"],
  properties: {
    thought: { type: "string" },
    action: { type: "string", enum: ["list_files", "read_file", "search", "replace_in_file", "run_checks", "finish"] },
    args: {
      type: "object",
      additionalProperties: false,
      required: ["path", "dir", "pattern", "fromLine", "old", "new", "summary"],
      properties: {
        path: { type: ["string", "null"] }, dir: { type: ["string", "null"] }, pattern: { type: ["string", "null"] },
        fromLine: { type: ["integer", "null"] }, old: { type: ["string", "null"] }, new: { type: ["string", "null"] }, summary: { type: ["string", "null"] },
      },
    },
  },
};

const SYSTEM = `You are TACK's autonomous engineering agent. TACK is a TypeScript sailing-routing app (server/ = Node, client/src = React, shared/ = types).
Each run you make ONE small, safe, useful improvement to the source code, then finish.
Actions (reply with exactly one JSON action per turn):
- list_files {dir}  - search {pattern}  - read_file {path, fromLine}
- replace_in_file {path, old, new}  (old must match exactly once; keep edits small)
- run_checks {}  (type check + test suite)
- finish {summary}  (what you changed and why; finish without edits if nothing is worth changing)
Rules: read before you edit. Never weaken safety limits or validation. Protected (read-only): server/benchmark/, server/strategies/runtime.ts, server/tack.test.ts, server/agent/, server/routing/geo.ts, package files, .env. Run run_checks after editing and fix failures before finishing. You have at most ${MAX_STEPS} actions.`;

export async function runAgent(goal: string, brief: string): Promise<AgentRun> {
  const run: AgentRun = { id: newId("agent"), startedAt: new Date().toISOString(), finishedAt: null, goal, status: "running", steps: [], filesChanged: [], gates: [], commit: null, summary: null };
  agentRuns.upsert(run);
  const changed = new Set<string>();
  try {
    prepareWorktree();
    const history: { role: "developer" | "user" | "assistant"; content: string }[] = [
      { role: "developer", content: SYSTEM },
      { role: "user", content: `GOAL: ${goal}\n\nDAILY BRIEF (today's signals from TACK):\n${brief}` },
    ];
    for (let n = 1; n <= MAX_STEPS; n++) {
      const { data } = await model.completeJson<{ thought: string; action: string; args: Record<string, any> }>(history, { name: "agent_action", schema: SCHEMA }, { maxTokens: 6000 });
      let result: string;
      if (data.action === "finish") {
        run.summary = data.args.summary ?? data.thought;
        run.steps.push({ n, thought: data.thought, action: "finish", args: { summary: run.summary }, result: "" });
        break;
      }
      try { result = tool(data.action, data.args ?? {}, changed); } catch (e) { result = `ERROR: ${(e as Error).message}`; }
      const args = Object.fromEntries(Object.entries(data.args ?? {}).filter(([, v]) => v != null));
      run.steps.push({ n, thought: data.thought, action: data.action, args, result: result.slice(0, 1500) });
      agentRuns.upsert(run);
      history.push({ role: "assistant", content: JSON.stringify(data) }, { role: "user", content: `RESULT:\n${result.slice(0, 6000)}` });
    }
    run.filesChanged = [...changed];
    if (!changed.size) {
      run.status = "no-change";
    } else {
      run.gates = runGates();
      if (run.gates.every((g) => g.passed)) {
        sh("git", ["add", "-A", "--", ...run.filesChanged]);
        const msg = `agent: ${(run.summary ?? goal).slice(0, 72)}\n\n${run.summary ?? ""}\n\nAutonomous TACK agent run ${run.id} (${model.primary.model}). Gates: type check, test suite.`;
        const c = sh("git", ["commit", "-q", "-m", msg]);
        run.commit = c.ok ? sh("git", ["rev-parse", "--short", "HEAD"]).out.trim() : null;
        run.status = run.commit ? "merged" : "failed";
      } else {
        sh("git", ["reset", "--hard"]);
        run.status = "rejected";
      }
    }
  } catch (e) {
    run.status = "failed";
    run.summary = (e as Error).message;
    sh("git", ["reset", "--hard"]);
  }
  run.finishedAt = new Date().toISOString();
  agentRuns.upsert(run);
  return run;
}
