import type { LogEntry } from "../../shared/types.js";
import { OBS_SCHEMA } from "../logbook/extract.js";
import { model } from "../model/provider.js";
import { CHANGE_SCHEMA, PREFERENCE_GUIDE } from "../preferences/objectives.js";

// Interprets one captain message. A single message can carry a watch report, a change of
// priorities and a question at the same time ("Crew is tired, 18 kn from the SE — can we ease off tonight?").

export interface Interpretation {
  intents: ("log_report" | "preference" | "question" | "chit_chat")[];
  observation: any | null;
  objectiveChange: any | null;
  question: string | null;
  via: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intents", "observation", "objectiveChange", "question"],
  properties: {
    intents: { type: "array", items: { type: "string", enum: ["log_report", "preference", "question", "chit_chat"] } },
    observation: { anyOf: [{ type: "null" }, OBS_SCHEMA] },
    objectiveChange: { anyOf: [{ type: "null" }, CHANGE_SCHEMA] },
    question: { type: ["string", "null"] },
  },
};

export async function interpret(message: string, nowIso: string): Promise<Interpretation> {
  const { data, via } = await model.completeJson<Omit<Interpretation, "via">>(
    [
      {
        role: "developer",
        content: `You are the intake layer of TACK, an onboard sailing tactician. Classify the captain's message and extract structure.
- log_report: the message reports observations (position, heading, speeds, wind, sails, sea, crew condition). Fill "observation"; use null for anything not stated; never invent numbers. Wind direction = where it comes FROM.
- preference: the message changes routing priorities or constraints. Fill "objectiveChange".
- question: the message asks something. Put the question in "question".
Otherwise set the field to null.

Objective rules:
${PREFERENCE_GUIDE}
Current time (UTC): ${nowIso}`,
      },
      { role: "user", content: message },
    ],
    { name: "captain_message", schema: SCHEMA },
    { maxTokens: 6000 },
  );
  return { ...data, via };
}

export function interpretOffline(message: string): Omit<Interpretation, "via" | "observation" | "objectiveChange"> {
  const t = message.toLowerCase();
  const intents: Interpretation["intents"] = [];
  if (/\d+(\.\d+)?\s*(kn|knots|kts)|heading|°|\bwind\b.*\d|crew (is|are)|reef|genoa|main/.test(t)) intents.push("log_report");
  if (/priorit|comfort|quick|fast|motor|deadline|arrive by|slow down|scenic|we have time|plenty of time|avoid/.test(t)) intents.push("preference");
  if (/\?$|^(what|when|where|why|how|which|did|do|is|are|can|show)\b/.test(t.trim())) intents.push("question");
  return { intents: intents.length ? intents : ["question"], question: intents.includes("question") || !intents.length ? message : null };
}

export async function answer(question: string, context: unknown): Promise<{ text: string; via: string }> {
  return model.complete(
    [
      {
        role: "developer",
        content: `You are TACK, an onboard sailing tactician assisting the captain. Answer concisely (≤ 120 words unless asked for detail) using ONLY the context provided.
- Distinguish forecasts (Open-Meteo, with retrieval time) from observations (logbook) and estimates (TACK routing engine).
- The route recommendation was made by SubQ Snap from TACK's candidate routes; explain trade-offs using the metrics.
- If the context does not contain the answer, say so. Never invent measurements or weather.
- The captain decides; TACK is not certified navigation software.`,
      },
      { role: "user", content: `CONTEXT:\n${JSON.stringify(context)}\n\nCAPTAIN: ${question}` },
    ],
    { maxTokens: 3000 },
  );
}

/** Offline query over the local logbook: keyword + simple statistics, no language model. */
export function answerOffline(question: string, entries: LogEntry[]): string {
  const t = question.toLowerCase();
  const obs = entries.filter((e) => e.kind === "observation" && e.observations);
  const words = t.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !["what", "when", "where", "which", "were", "have", "with", "that", "this", "there", "during", "about", "show"].includes(w));
  const stem = (w: string) => w.replace(/(es|s)$/, "");
  const hits = obs.filter((e) => words.some((w) => (e.observations!.remarks ?? e.rawText ?? "").toLowerCase().includes(stem(w))));
  const lines: string[] = [];
  if (/strongest|max(imum)? wind|windiest/.test(t)) {
    const m = obs.filter((e) => e.observations!.twsKn != null).sort((a, b) => b.observations!.twsKn! - a.observations!.twsKn!)[0];
    if (m) lines.push(`Strongest logged wind: ${m.observations!.twsKn} kn on ${m.timestamp.slice(0, 16).replace("T", " ")} — "${m.observations!.remarks ?? ""}"`);
  }
  if (/fastest|max(imum)? speed|top speed/.test(t)) {
    const m = obs.filter((e) => e.observations!.sogKn != null).sort((a, b) => b.observations!.sogKn! - a.observations!.sogKn!)[0];
    if (m) lines.push(`Fastest logged SOG: ${m.observations!.sogKn} kn on ${m.timestamp.slice(0, 16).replace("T", " ")}`);
  }
  if (/how many|count|entries/.test(t)) lines.push(`${obs.length} observation entries in the logbook.`);
  if (hits.length) {
    lines.push(`${hits.length} matching entr${hits.length === 1 ? "y" : "ies"}:`);
    for (const e of hits.slice(0, 8)) lines.push(`• ${e.timestamp.slice(0, 16).replace("T", " ")} — ${e.observations!.remarks ?? e.rawText}`);
  }
  if (!lines.length) lines.push("No matching logbook entries found offline. Full natural-language answers need the language model (online or on-board).");
  return lines.join("\n");
}
