import type { ExtractionInfo, LatLon, Observations, SailPlan } from "../../shared/types.js";
import { model } from "../model/provider.js";

// Converts a captain's free-text report into structured observations.
// Rule: never invent measurements — anything not stated is null and listed as missing.

export const KEY_FIELDS = ["position", "headingDeg", "sogKn", "stwKn", "twsKn", "twdDeg", "sailPlan", "crewCondition", "seaState"] as const;

const nullable = (type: string | string[], extra: Record<string, unknown> = {}) => ({ type: [...(Array.isArray(type) ? type : [type]), "null"], ...extra });

export const OBS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["position", "headingDeg", "cogDeg", "sogKn", "stwKn", "twsKn", "twdDeg", "windReference", "gustKn", "pressureHpa", "waveHeightM", "seaState", "sailPlan", "crewCondition", "remarks", "confidence", "notes"],
  properties: {
    position: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["lat", "lon"], properties: { lat: { type: "number", description: "decimal degrees, south negative" }, lon: { type: "number", description: "decimal degrees, west negative" } } }] },
    headingDeg: nullable("number", { description: "compass heading the bow points, degrees" }),
    cogDeg: nullable("number"),
    sogKn: nullable("number", { description: "speed over ground, knots" }),
    stwKn: nullable("number", { description: "speed through water, knots" }),
    twsKn: nullable("number", { description: "wind speed, knots" }),
    twdDeg: nullable("number", { description: "direction the wind blows FROM, degrees true" }),
    windReference: nullable("string", { enum: ["true", "apparent", "unspecified", null] }),
    gustKn: nullable("number"),
    pressureHpa: nullable("number"),
    waveHeightM: nullable("number"),
    seaState: nullable("string", { enum: ["calm", "slight", "moderate", "rough", "very rough", null] }),
    sailPlan: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["main", "headsail", "engine", "reefLevel"],
          properties: {
            main: { type: "string", enum: ["full", "reefed", "down", "unknown"] },
            headsail: { type: "string", enum: ["full", "reefed", "down", "unknown"] },
            engine: nullable("boolean"),
            reefLevel: nullable("integer"),
          },
        },
      ],
    },
    crewCondition: nullable("string"),
    remarks: nullable("string", { description: "anything else noteworthy, in the captain's words" }),
    confidence: { type: "number", description: "0..1 confidence in the extraction" },
    notes: { type: "array", items: { type: "string" }, description: "ambiguities or assumptions" },
  },
} as const;

const SYSTEM = `You convert a sailing captain's logbook report into structured JSON.
Rules:
- Extract only what is explicitly stated. Use null for anything not stated. Never estimate or invent measurements.
- Coordinates: convert degrees/minutes to decimal degrees; south and west are negative.
- Wind direction is the direction the wind comes FROM. If the report does not say true or apparent, windReference = "unspecified".
- "Full main and genoa" means main full, headsail full. Engine is null unless motoring/engine/sailing-only is mentioned.
- seaState only if the report describes the sea.
- Put ambiguities in notes.`;

export function missingFields(o: Observations): string[] {
  return KEY_FIELDS.filter((k) => o[k] == null);
}

export function emptyObservations(): Observations {
  return {
    position: null, headingDeg: null, cogDeg: null, sogKn: null, stwKn: null, twsKn: null, twdDeg: null,
    windReference: null, gustKn: null, pressureHpa: null, waveHeightM: null, seaState: null, sailPlan: null,
    crewCondition: null, tripLogNm: null, tanks: null, remarks: null,
  };
}

export async function extractWithModel(text: string): Promise<{ obs: Observations; info: ExtractionInfo }> {
  const { data, via } = await model.completeJson<any>(
    [
      { role: "developer", content: SYSTEM },
      { role: "user", content: text },
    ],
    { name: "logbook_observation", schema: OBS_SCHEMA as unknown as Record<string, unknown> },
  );
  return sanitizeObservation(data, via);
}

/** Validate model-extracted observations; implausible values are discarded, never "fixed". */
export function sanitizeObservation(data: any, via: string): { obs: Observations; info: ExtractionInfo } {
  const obs: Observations = {
    ...emptyObservations(),
    ...data,
    sailPlan: data.sailPlan ? { ...data.sailPlan, raw: null } : null,
  };
  delete (obs as any).confidence;
  delete (obs as any).notes;
  // Sanity checks: reject impossible values rather than trusting them.
  const notes: string[] = [...(data.notes ?? [])];
  const check = (k: keyof Observations, ok: (v: number) => boolean) => {
    const v = obs[k] as number | null;
    if (v != null && !ok(v)) { notes.push(`Discarded implausible ${String(k)}=${v}`); (obs as any)[k] = null; }
  };
  check("headingDeg", (v) => v >= 0 && v <= 360);
  check("cogDeg", (v) => v >= 0 && v <= 360);
  check("twdDeg", (v) => v >= 0 && v <= 360);
  check("sogKn", (v) => v >= 0 && v < 40);
  check("stwKn", (v) => v >= 0 && v < 40);
  check("twsKn", (v) => v >= 0 && v < 120);
  if (obs.position && (Math.abs(obs.position.lat) > 90 || Math.abs(obs.position.lon) > 180)) { notes.push("Discarded invalid position"); obs.position = null; }
  return { obs, info: { method: via, confidence: clamp01(data.confidence ?? 0.7), missingFields: missingFields(obs), notes } };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/* ───────────── Offline rule-based parser (used when no model is reachable) ───────────── */

const COMPASS: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};
export const compassToDeg = (s: string): number | null => COMPASS[s.toUpperCase()] ?? null;

export function parseCoord(s: string): number | null {
  const m = s.trim().match(/^(-?\d{1,3}(?:\.\d+)?)(?:[°\s]+(\d{1,2}(?:\.\d+)?)['’′]?)?\s*([NSEW])?$/i);
  if (!m) return null;
  let v = Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
  if (m[3] && /[SW]/i.test(m[3])) v = -v;
  return v;
}

function findPosition(t: string): LatLon | null {
  const re = /(\d{1,2})[°\s]+(\d{1,2}(?:\.\d+)?)\s*['’′]?\s*([NS])[\s,;/]+(\d{1,3})[°\s]+(\d{1,2}(?:\.\d+)?)\s*['’′]?\s*([EW])/i;
  const m = t.match(re);
  if (m) {
    const lat = (Number(m[1]) + Number(m[2]) / 60) * (/S/i.test(m[3]) ? -1 : 1);
    const lon = (Number(m[4]) + Number(m[5]) / 60) * (/W/i.test(m[6]) ? -1 : 1);
    return { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
  }
  const d = t.match(/(\d{1,2}\.\d+)\s*°?\s*([NS])[\s,;/]+(\d{1,3}\.\d+)\s*°?\s*([EW])/i);
  if (d) return { lat: Number(d[1]) * (/S/i.test(d[2]) ? -1 : 1), lon: Number(d[3]) * (/W/i.test(d[4]) ? -1 : 1) };
  return null;
}

export function sailPlanFromText(t: string): SailPlan | null {
  const s = t.toLowerCase();
  const has = (re: RegExp) => re.test(s);
  if (!has(/main|genoa|jib|headsail|engine|motor|reef|spinnaker|gennaker/)) return null;
  const reefMatch = s.match(/(\d|one|two|three|first|second|third)\s*(?:st|nd|rd|th)?\s*reef/);
  const words: Record<string, number> = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3 };
  const reefLevel = reefMatch ? Number(reefMatch[1]) || words[reefMatch[1]] || 1 : null;
  const main = has(/main (?:is )?down|no main|dropped the main/) ? "down" : has(/reef/) && has(/main/) ? "reefed" : has(/full main|main up|main\b/) ? "full" : "unknown";
  const headsail = has(/genoa (?:is )?(?:down|furled)|furled the (?:genoa|jib)|no (?:genoa|jib)/) ? "down" : has(/reefed (?:genoa|jib)|(?:genoa|jib) reefed|partly furled/) ? "reefed" : has(/genoa|jib|headsail/) ? "full" : "unknown";
  const engine = has(/engine (?:off|stopped)|sailing only|no engine|motor off/) ? false : has(/engine|motor/) ? true : null;
  return { main, headsail, engine, reefLevel, raw: null };
}

export function extractOffline(text: string): { obs: Observations; info: ExtractionInfo } {
  const t = text.replace(/\s+/g, " ");
  const num = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]) : null; };
  const obs = emptyObservations();
  obs.position = findPosition(t);
  obs.headingDeg = num(/heading\s*(?:of\s*)?(\d{1,3}(?:\.\d+)?)/i);
  obs.cogDeg = num(/(?:cog|course over ground)\s*(?:of\s*)?(\d{1,3})/i);
  obs.sogKn = num(/(\d+(?:\.\d+)?)\s*(?:knots|kn|kts?)\s*(?:over (?:the )?ground|sog)/i) ?? num(/sog\s*(\d+(?:\.\d+)?)/i);
  obs.stwKn = num(/(\d+(?:\.\d+)?)\s*(?:knots|kn|kts?)?\s*through (?:the )?water/i) ?? num(/stw\s*(\d+(?:\.\d+)?)/i);
  const w1 = t.match(/wind\s*(?:is\s*)?(?:at\s*)?(\d+(?:\.\d+)?)\s*(?:knots|kn|kts?)\s*(?:from\s*(?:the\s*)?)?(\d{1,3}|[NSEW]{1,3})?/i);
  const w2 = t.match(/wind\s*(?:is\s*)?from\s*(?:the\s*)?(\d{1,3}|[NSEW]{1,3})\s*(?:degrees\s*)?(?:at\s*)?(\d+(?:\.\d+)?)\s*(?:knots|kn|kts?)/i);
  if (w1) { obs.twsKn = Number(w1[1]); if (w1[2]) obs.twdDeg = /\d/.test(w1[2]) ? Number(w1[2]) : compassToDeg(w1[2]); }
  else if (w2) { obs.twsKn = Number(w2[2]); obs.twdDeg = /\d/.test(w2[1]) ? Number(w2[1]) : compassToDeg(w2[1]); }
  if (obs.twsKn != null) obs.windReference = /apparent/i.test(t) ? "apparent" : /true wind/i.test(t) ? "true" : "unspecified";
  obs.gustKn = num(/gust(?:s|ing)?\s*(?:to|of)?\s*(\d+(?:\.\d+)?)/i);
  obs.pressureHpa = num(/(\d{3,4}(?:\.\d+)?)\s*(?:hpa|mb)/i);
  obs.waveHeightM = num(/(\d+(?:\.\d+)?)\s*(?:m|metre|meter)s?\s*(?:waves|swell|seas?)/i);
  const sea = t.match(/\b(calm|slight|moderate|rough|very rough)\s+(?:sea|seas|water)/i);
  obs.seaState = sea ? (sea[1].toLowerCase() as Observations["seaState"]) : null;
  obs.sailPlan = sailPlanFromText(t);
  const crew = t.match(/crew\s+(?:is\s+|are\s+|feels?\s+|seems?\s+)?((?:very\s+|quite\s+|a bit\s+)?(?:tired|exhausted|rested|fine|ok|good|happy|seasick|sick|cold|wet|fresh|comfortable|sleepy|fatigued|well)[^.]*)/i);
  obs.crewCondition = crew ? crew[1].trim() : null;
  const found = Object.values(obs).filter((v) => v != null).length;
  return {
    obs,
    info: {
      method: "offline-rule-parser",
      confidence: found ? 0.55 : 0.1,
      missingFields: missingFields(obs),
      notes: ["Parsed on board without a language model; will be re-interpreted when connectivity returns."],
      pendingModelReview: true,
    },
  };
}
