import type { EffectiveObjectives, ObjectiveChange, Objectives, SoftKey, SoftWeights } from "../../shared/types.js";
import { model } from "../model/provider.js";
import { newId } from "../store/jsonStore.js";

// Captain objectives. HARD constraints (deadline, wind/wave limits, restricted areas) are
// enforced by the routing engine and can never be traded away by a soft preference.
// SOFT objectives are weights 0..1. Temporary objectives override weights until they expire.

export const SOFT_KEYS: SoftKey[] = ["speed", "comfort", "fuel", "scenic", "sailing", "morale"];

export const defaultObjectives = (): Objectives => ({
  hard: { arrivalDeadline: null, maxTwsKn: null, maxWaveM: null, restrictedAreas: [], other: [] },
  base: { speed: 0.6, comfort: 0.5, fuel: 0.4, scenic: 0.1, sailing: 0.4, morale: 0.4 },
  temporary: [],
  notes: [],
  updatedAt: new Date().toISOString(),
});

export function effective(o: Objectives, now = Date.now()): EffectiveObjectives {
  const active = o.temporary.filter((t) => Date.parse(t.expiresAt) > now);
  const weights: SoftWeights = { ...o.base };
  for (const t of active) for (const k of SOFT_KEYS) if (t.weights[k] != null) weights[k] = t.weights[k]!;
  return { hard: o.hard, weights, activeTemporary: active, notes: o.notes };
}

export function applyChange(o: Objectives, c: ObjectiveChange, text: string, now = new Date()): Objectives {
  const next: Objectives = structuredClone(o);
  const h = c.hard;
  if (h.arrivalDeadline !== undefined) next.hard.arrivalDeadline = h.arrivalDeadline;
  if (h.maxTwsKn !== undefined) next.hard.maxTwsKn = h.maxTwsKn;
  if (h.maxWaveM !== undefined) next.hard.maxWaveM = h.maxWaveM;
  if (h.addRestrictedAreas?.length) next.hard.restrictedAreas.push(...h.addRestrictedAreas);
  if (h.addOther?.length) next.hard.other.push(...h.addOther);
  for (const k of SOFT_KEYS) if (c.baseWeights[k] != null) next.base[k] = clamp(c.baseWeights[k]!);
  if (c.temporary && Object.keys(c.temporary.weights).length) {
    const hours = Math.max(0.5, Math.min(24 * 14, c.temporary.durationHours || 12));
    next.temporary.push({
      id: newId("tmp"),
      text: c.temporary.text || text,
      weights: Object.fromEntries(Object.entries(c.temporary.weights).map(([k, v]) => [k, clamp(v as number)])),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    });
  }
  next.notes.push(...c.notes);
  next.temporary = next.temporary.filter((t) => Date.parse(t.expiresAt) > now.getTime());
  next.updatedAt = now.toISOString();
  return next;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

const weightProps = Object.fromEntries(SOFT_KEYS.map((k) => [k, { type: ["number", "null"], description: "0..1, null = unchanged" }]));

export const CHANGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "hard", "baseWeights", "temporary", "notes", "clarificationNeeded", "confidence"],
  properties: {
    summary: { type: "string" },
    hard: {
      type: "object",
      additionalProperties: false,
      required: ["arrivalDeadline", "maxTwsKn", "maxWaveM", "addRestrictedAreas", "addOther"],
      properties: {
        arrivalDeadline: { type: ["string", "null"], description: "ISO 8601 UTC; null = unchanged" },
        maxTwsKn: { type: ["number", "null"] },
        maxWaveM: { type: ["number", "null"] },
        addRestrictedAreas: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["name", "lat", "lon", "radiusNm"], properties: { name: { type: "string" }, lat: { type: "number" }, lon: { type: "number" }, radiusNm: { type: "number" } } },
        },
        addOther: { type: "array", items: { type: "string" } },
      },
    },
    baseWeights: { type: "object", additionalProperties: false, required: SOFT_KEYS, properties: weightProps },
    temporary: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["weights", "durationHours", "text"],
          properties: {
            weights: { type: "object", additionalProperties: false, required: SOFT_KEYS, properties: weightProps },
            durationHours: { type: "number" },
            text: { type: "string" },
          },
        },
      ],
    },
    notes: { type: "array", items: { type: "string" } },
    clarificationNeeded: { type: ["string", "null"] },
    confidence: { type: "number" },
  },
};

export const PREFERENCE_GUIDE = `Translate the captain's instruction into routing objectives.
HARD constraints (only if explicitly stated): arrivalDeadline (ISO UTC; resolve weekdays relative to the current time, end of that day 23:59 local≈UTC unless a time is given), maxTwsKn, maxWaveM, restricted areas, other explicit operational limits.
SOFT weights 0..1: speed (arrive sooner), comfort (gentle motion, smaller waves, less beating), fuel (less motoring), scenic (scenic opportunities), sailing (good sailing conditions, sail rather than motor), morale (crew happiness/special occasions).
- Statements limited in time ("tonight", "for the next 6 hours", "tomorrow", "until the front passes") go in temporary with durationHours; tonight ≈ until 08:00 next morning.
- Lasting priorities go in baseWeights. Use null for weights that do not change.
- A wish for comfort never relaxes a safety limit.
- Do not invent constraints. If something is ambiguous (e.g. an unknown place), put a short question in clarificationNeeded.
- Notes: things TACK TACK cannot evaluate (e.g. anchorage quality offshore) — say so.`;

export async function parsePreference(text: string, nowIso: string): Promise<ObjectiveChange> {
  const { data, via } = await model.completeJson<any>(
    [
      { role: "developer", content: `${PREFERENCE_GUIDE}\nCurrent time (UTC): ${nowIso}` },
      { role: "user", content: text },
    ],
    { name: "objective_change", schema: CHANGE_SCHEMA },
  );
  return normaliseChange(data, via);
}

export function normaliseChange(data: any, method: string): ObjectiveChange {
  const strip = (w: Record<string, number | null> | undefined) => Object.fromEntries(Object.entries(w ?? {}).filter(([, v]) => v != null)) as Partial<SoftWeights>;
  const hard: ObjectiveChange["hard"] = {};
  if (data.hard?.arrivalDeadline) hard.arrivalDeadline = new Date(data.hard.arrivalDeadline).toISOString();
  if (data.hard?.maxTwsKn != null) hard.maxTwsKn = data.hard.maxTwsKn;
  if (data.hard?.maxWaveM != null) hard.maxWaveM = data.hard.maxWaveM;
  if (data.hard?.addRestrictedAreas?.length) hard.addRestrictedAreas = data.hard.addRestrictedAreas;
  if (data.hard?.addOther?.length) hard.addOther = data.hard.addOther;
  return {
    method,
    summary: data.summary ?? "",
    hard,
    baseWeights: strip(data.baseWeights),
    temporary: data.temporary ? { weights: strip(data.temporary.weights), durationHours: data.temporary.durationHours, text: data.temporary.text } : null,
    notes: data.notes ?? [],
    clarificationNeeded: data.clarificationNeeded ?? null,
    confidence: data.confidence ?? 0.7,
  };
}

/** Keyword fallback used offline. Deliberately conservative: never sets hard constraints. */
export function parsePreferenceOffline(text: string): ObjectiveChange {
  const t = text.toLowerCase();
  const w: Partial<SoftWeights> = {};
  if (/quick|fast|asap|soon as possible|hurry/.test(t)) w.speed = 0.95;
  if (/comfort|exhausted|tired|gentle|easy|seasick|rest/.test(t)) { w.comfort = 0.95; if (/slow down|exhausted/.test(t)) w.speed = 0.2; }
  if (/motor|fuel|diesel|engine off/.test(t)) w.fuel = 0.9;
  if (/good sailing|sail more|sailing conditions/.test(t)) w.sailing = 0.9;
  if (/scenic|beautiful|anchorage/.test(t)) w.scenic = 0.8;
  if (/birthday|celebrat|morale/.test(t)) w.morale = 0.9;
  if (/plenty of time|we have time|no rush/.test(t)) w.speed = Math.min(w.speed ?? 1, 0.2);
  const temporary = /tonight|this evening|next \d+ hours|tomorrow/.test(t);
  const hoursMatch = t.match(/next (\d+) hours/);
  return {
    method: "offline-keyword-parser",
    summary: Object.keys(w).length ? `Adjusted ${Object.keys(w).join(", ")} (offline keyword parse)` : "No objective recognised offline",
    hard: {},
    baseWeights: temporary ? {} : w,
    temporary: temporary ? { weights: w, durationHours: hoursMatch ? Number(hoursMatch[1]) : 12, text } : null,
    notes: ["Parsed offline with keywords; deadlines and limits need the language model or the form."],
    clarificationNeeded: /by (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.test(t) ? "Deadlines can't be interpreted offline — please set the arrival deadline in the objectives form." : null,
    confidence: Object.keys(w).length ? 0.5 : 0.1,
  };
}
