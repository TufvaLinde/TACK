import { decisions, liveEntries } from "../app.js";
import { intelligence } from "../intelligence/store.js";
import { strategies } from "../strategies/runtime.js";

/** Today's signals for the autonomous agent: what went wrong or was uncertain recently. */
export async function buildBrief(): Promise<string> {
  const lines: string[] = [];
  const obs = liveEntries().filter((e) => e.kind === "observation").slice(-15);
  for (const e of obs) {
    const ex = e.extraction;
    if (!ex) continue;
    if (ex.confidence < 0.7 || ex.notes.length || ex.pendingModelReview)
      lines.push(`- Log extraction (${ex.method}, confidence ${ex.confidence}) of "${(e.rawText ?? "").slice(0, 140)}" → missing ${ex.missingFields.join(", ") || "none"}; notes: ${ex.notes.join(" | ").slice(0, 200)}`);
  }
  for (const d of decisions.all().slice(-5)) {
    if (d.error || d.lowConfidence) lines.push(`- Decision ${d.id}: engine ${d.engine}, confidence ${d.confidence ?? "n/a"}${d.error ? `, error: ${d.error}` : ""}`);
  }
  const run = (await intelligence.listRuns())[0];
  if (run) lines.push(`- Last strategy improvement run: ${run.status} (${run.baseVersion} → ${run.candidateVersion ?? "none"})`);
  lines.push(`- Production routing strategy: ${strategies.production().meta.version}`);
  return lines.length ? lines.join("\n") : "- No notable failures recorded today.";
}

export const DEFAULT_GOAL = "Look at today's brief and make one small improvement that would have handled one of these cases better (for example the offline log parser in server/logbook/extract.ts, or clearer messages). If nothing is worth changing, finish without edits.";
