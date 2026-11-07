import crypto from "node:crypto";
import type { LogEntry, NoteInterpretation, Observations, SailPlan, Voyage } from "../../shared/types.js";
import { model } from "../model/provider.js";
import { compassToDeg, emptyObservations, missingFields, parseCoord } from "./extract.js";

// Historical logbook import.
//
// Format inspected in the supplied atlantic.csv (2026 BVI → Azores crossing):
//   pipe-delimited, header: date|time|lat|lon|cog|sog|log|wind|pres|sail|diesel|water|obs
//   date  "26/4" (day/month, no year)        time "12:01" (no time zone)
//   lat   "18 23.2N"  lon "064 42.5W"         cog degrees, sog knots (over ground)
//   log   cumulative distance (nm)            wind "SSE12" = from SSE at 12 kn; sometimes
//         direction only ("NW") or blank      pres hPa
//   sail  letters: M = mainsail, G = genoa, E = engine (any order, e.g. "MGE")
//   diesel / water  two gauge readings "86/89" (units not stated — stored raw)
//   obs   free-text crew remarks
// There is no speed-through-water or heading column, and the wind reference
// (true/apparent) is not recorded. These gaps are carried into each entry.

export interface ImportInspection {
  delimiter: string;
  headers: string[];
  rows: number;
  recognisedFormat: string | null;
  mapping: Record<string, string>;
  unmappedColumns: string[];
  sample: Record<string, string>[];
  issues: string[];
}

const SYNONYMS: Record<string, string[]> = {
  date: ["date", "day"],
  time: ["time", "utc", "hour"],
  lat: ["lat", "latitude"],
  lon: ["lon", "long", "longitude"],
  cog: ["cog", "course"],
  heading: ["heading", "hdg"],
  sog: ["sog", "speed", "speed_over_ground"],
  stw: ["stw", "boatspeed", "bsp", "speed_through_water"],
  log: ["log", "trip", "distance"],
  wind: ["wind"],
  tws: ["tws", "wind_speed"],
  twd: ["twd", "wind_dir", "wind_direction"],
  pres: ["pres", "pressure", "baro", "hpa"],
  sail: ["sail", "sails", "rig"],
  diesel: ["diesel", "fuel"],
  water: ["water"],
  obs: ["obs", "remarks", "notes", "comment", "observations"],
  timestamp: ["timestamp", "datetime"],
};

export function inspectDelimited(text: string): ImportInspection {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const first = lines[0] ?? "";
  const delimiter = ["|", "\t", ";", ","].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const headers = first.split(delimiter).map((h) => h.trim().toLowerCase());
  const mapping: Record<string, string> = {};
  for (const h of headers) {
    const key = Object.entries(SYNONYMS).find(([, syn]) => syn.includes(h.replace(/\s+/g, "_")))?.[0];
    if (key) mapping[h] = key;
  }
  const rows = lines.slice(1).map((l) => l.split(delimiter));
  const issues: string[] = [];
  const badWidth = rows.filter((r) => r.length !== headers.length).length;
  if (badWidth) issues.push(`${badWidth} rows have a different column count than the header`);
  const atlantic = ["date", "time", "lat", "lon", "cog", "sog", "log", "wind", "pres", "sail", "diesel", "water", "obs"].every((h) => headers.includes(h));
  if (atlantic) {
    issues.push("Dates are day/month without a year; a year must be supplied.");
    issues.push("Times have no time zone; they are interpreted as UTC for ordering and flagged.");
    issues.push("No speed-through-water or heading column; performance learning uses SOG/COG at reduced weight.");
    issues.push("Wind reference (true/apparent) not recorded.");
  }
  return {
    delimiter,
    headers,
    rows: rows.length,
    recognisedFormat: atlantic ? "pipe-delimited deck log (date|time|lat|lon|cog|sog|log|wind|pres|sail|diesel|water|obs)" : Object.keys(mapping).length ? "generic delimited log" : null,
    mapping,
    unmappedColumns: headers.filter((h) => !mapping[h]),
    sample: rows.slice(0, 3).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))),
    issues,
  };
}

function sailCode(code: string): SailPlan | null {
  const c = code.trim().toUpperCase();
  if (!c) return null;
  return {
    main: c.includes("M") ? "full" : "down",
    headsail: c.includes("G") ? "full" : "down",
    engine: c.includes("E"),
    reefLevel: null,
    raw: c,
  };
}

function parseWind(s: string): { twd: number | null; tws: number | null } {
  const m = s.trim().toUpperCase().match(/^([NESW]{1,3})?\s*(\d+(?:\.\d+)?)?$/);
  if (!m) return { twd: null, tws: null };
  return { twd: m[1] ? compassToDeg(m[1]) : null, tws: m[2] ? Number(m[2]) : null };
}

const numOrNull = (s: string | undefined) => (s == null || s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));

export function importDelimited(text: string, file: string, opts: { year: number; voyageId: string }): { entries: LogEntry[]; inspection: ImportInspection } {
  const insp = inspectDelimited(text);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const key = (h: string) => insp.mapping[h];
  const fileHash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 8);
  const recordedAt = new Date().toISOString();
  const entries: LogEntry[] = [];

  lines.slice(1).forEach((line, idx) => {
    const cells = line.split(insp.delimiter);
    const row: Record<string, string> = {};
    insp.headers.forEach((h, i) => { const k = key(h); if (k) row[k] = (cells[i] ?? "").trim(); });
    const notes: string[] = [];
    let confidence = 0.85;

    // ── timestamp
    let ts: string | null = null;
    let tsProv = "";
    if (row.timestamp && !Number.isNaN(Date.parse(row.timestamp))) {
      ts = new Date(row.timestamp).toISOString();
      tsProv = "timestamp column";
    } else if (row.date) {
      const dm = row.date.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
      const tm = (row.time ?? "").match(/^(\d{1,2}):(\d{2})/);
      if (dm) {
        const year = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : opts.year;
        const d = new Date(Date.UTC(year, Number(dm[2]) - 1, Number(dm[1]), tm ? Number(tm[1]) : 12, tm ? Number(tm[2]) : 0));
        ts = d.toISOString();
        tsProv = `log date "${row.date}" ${row.time ?? ""}; ${dm[3] ? "" : `year ${opts.year} supplied at import; `}time zone not recorded — interpreted as UTC`;
        if (!tm) { notes.push("No time recorded; noon assumed for ordering"); confidence -= 0.1; }
      }
    }
    if (!ts) { ts = recordedAt; tsProv = "no usable date in row — import time used"; confidence -= 0.3; }

    // ── observations
    const obs: Observations = emptyObservations();
    const lat = row.lat ? parseCoord(row.lat) : null;
    const lon = row.lon ? parseCoord(row.lon) : null;
    obs.position = lat != null && lon != null ? { lat: +lat.toFixed(4), lon: +lon.toFixed(4) } : null;
    obs.cogDeg = numOrNull(row.cog);
    obs.headingDeg = numOrNull(row.heading);
    obs.sogKn = numOrNull(row.sog);
    obs.stwKn = numOrNull(row.stw);
    if (row.wind != null) {
      const w = parseWind(row.wind);
      obs.twdDeg = w.twd; obs.twsKn = w.tws;
      if (row.wind && w.tws == null) notes.push(`Wind recorded as "${row.wind}" — direction only, no speed`);
      if (!row.wind) notes.push("Wind not recorded");
    } else {
      obs.twsKn = numOrNull(row.tws); obs.twdDeg = numOrNull(row.twd);
    }
    obs.windReference = obs.twsKn != null || obs.twdDeg != null ? "unspecified" : null;
    obs.pressureHpa = numOrNull(row.pres);
    obs.sailPlan = row.sail != null ? sailCode(row.sail) : null;
    if (obs.sailPlan) notes.push("Sail code M/G/E records which sails are set, not reefs — set sails treated as full");
    obs.tripLogNm = numOrNull(row.log);
    obs.tanks = row.diesel != null || row.water != null ? { diesel: row.diesel || null, water: row.water || null } : null;
    obs.remarks = row.obs ? row.obs.replace(/^"|"$/g, "") : null;
    if (obs.sogKn === 0 && idx === 0) notes.push("SOG 0 at departure (alongside / leaving harbour)");

    entries.push({
      id: `imp_${fileHash}_${String(idx).padStart(4, "0")}`,
      voyageId: opts.voyageId,
      kind: "observation",
      timestamp: ts,
      timestampProvenance: tsProv,
      recordedAt,
      source: `import:${file}`,
      rawText: line,
      observations: obs,
      extraction: { method: `delimited-import:${file}`, confidence: Math.max(0.1, confidence), missingFields: missingFields(obs).filter((f) => f !== "crewCondition" && f !== "seaState"), notes },
      interpretation: null,
    });
  });
  return { entries, inspection: insp };
}

export function importJson(text: string, file: string, opts: { voyageId: string }): LogEntry[] {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error("JSON logbook must be an array of entries");
  const recordedAt = new Date().toISOString();
  return arr.map((e: any, i: number) => {
    if (e.observations && e.timestamp) return { ...e, id: e.id ?? `impj_${i}`, voyageId: opts.voyageId, source: `import:${file}` } as LogEntry;
    // flat records: reuse the delimited mapping by converting to a one-row table
    const headers = Object.keys(e);
    const one = importDelimited(`${headers.join("|")}\n${headers.map((h) => String(e[h] ?? "")).join("|")}`, file, { year: new Date().getUTCFullYear(), voyageId: opts.voyageId }).entries[0];
    return { ...one, id: `impj_${i}`, recordedAt };
  });
}

export function voyageFromEntries(entries: LogEntry[], id: string, name: string): Voyage {
  const withPos = entries.filter((e) => e.observations?.position).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const first = withPos[0], last = withPos[withPos.length - 1];
  return {
    id,
    name,
    kind: "historical",
    start: { ...first.observations!.position!, label: first.observations?.remarks?.slice(0, 60) ?? "First logged position" },
    destination: { ...last.observations!.position!, label: "Last logged position" },
    departureTime: first.timestamp,
    notes: `Imported ${entries.length} entries.`,
  };
}

/* ───────────── Model interpretation of free-text remarks ───────────── */

const NOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "seaState", "crewMood", "events", "confidence"],
        properties: {
          id: { type: "string" },
          seaState: { type: ["string", "null"], enum: ["calm", "slight", "moderate", "rough", "very rough", null] },
          crewMood: { type: ["string", "null"], description: "short phrase, only if the remark indicates it" },
          events: { type: "array", items: { type: "string" }, description: "notable events: repairs, wildlife, sail changes, equipment failures, traffic" },
          confidence: { type: "number" },
        },
      },
    },
  },
};

export async function interpretRemarks(entries: LogEntry[]): Promise<Map<string, NoteInterpretation>> {
  const withText = entries.filter((e) => e.observations?.remarks);
  const batches: LogEntry[][] = [];
  for (let i = 0; i < withText.length; i += 45) batches.push(withText.slice(i, i + 45));
  const out = new Map<string, NoteInterpretation>();
  await Promise.all(
    batches.map(async (b) => {
      const { data, via } = await model.completeJson<{ items: (NoteInterpretation & { id: string })[] }>(
        [
          {
            role: "developer",
            content:
              "You read short crew remarks from a sailing logbook. For each remark, classify the sea state ONLY if the remark describes the sea or waves (e.g. 'calm', 'big waves', 'very wavy'); otherwise null. 'Calm' about wind alone still implies calm sea only if no waves are mentioned — use 'calm' then. Extract crew mood only if expressed. List notable events. Do not invent. Return one item per id.",
          },
          { role: "user", content: JSON.stringify(b.map((e) => ({ id: e.id, remark: e.observations!.remarks }))) },
        ],
        { name: "remark_interpretations", schema: NOTE_SCHEMA },
        { maxTokens: 16000 },
      );
      for (const it of data.items ?? []) out.set(it.id, { method: via, seaState: it.seaState ?? null, crewMood: it.crewMood ?? null, events: it.events ?? [], confidence: it.confidence ?? 0.6 });
    }),
  );
  return out;
}
