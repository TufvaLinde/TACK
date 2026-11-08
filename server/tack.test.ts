import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { parsePolarCsv, polarSpeed } from "./vessel/polar.js";
import { BASELINE_SOURCE, validate } from "./strategies/runtime.js";
import { extractOffline } from "./logbook/extract.js";
import { importDelimited } from "./logbook/importer.js";

const polar = parsePolarCsv("twa\\tws,6,12\n45,3,5\n90,4,7\n", "t", "t");

test("polar interpolates bilinearly and folds TWA", () => {
  assert.equal(polarSpeed(polar, 9, 90), 5.5);
  assert.equal(polarSpeed(polar, 12, 270), 7);
  assert.equal(polarSpeed(polar, 12, 67.5), 6);
});

test("baseline strategy passes validation", () => {
  assert.equal(validate(BASELINE_SOURCE).ok, true);
});

test("strategy sandbox rejects I/O, loops and out-of-range outputs", () => {
  assert.equal(validate(BASELINE_SOURCE.replace("let f = 1;", "let f = 1; require('fs');")).ok, false);
  assert.equal(validate(BASELINE_SOURCE.replace("let f = 1;", "let f = 1; while (true) {}")).ok, false);
  assert.equal(validate(BASELINE_SOURCE.replace("return f;", "return 5;")).ok, false);
  assert.equal(validate(BASELINE_SOURCE.replace("return f;", "return process.exit(1);")).ok, false);
});

test("improvement agent cannot reach held-out data or the evaluator", () => {
  const code = fs.readFileSync(new URL("./improvement/agent.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /heldout\(|evaluate\(|benchmark\/evaluator|listEvaluations/);
});

test("offline parser never invents missing values", () => {
  const r = extractOffline("Heading 245, 6.4 knots over ground. Crew is tired.");
  assert.equal(r.obs.headingDeg, 245);
  assert.equal(r.obs.sogKn, 6.4);
  assert.equal(r.obs.stwKn, null);
  assert.equal(r.obs.twsKn, null);
  assert.ok(r.info.missingFields.includes("stwKn"));
});

test("pipe-delimited deck log imports with provenance", () => {
  const { entries, inspection } = importDelimited("date|time|lat|lon|cog|sog|log|wind|pres|sail|diesel|water|obs\n26/4|18:04|18 52.6N|064 20.1W|038|7.0|436|SSE12|1011|MG|88/100|82/82|Full sail", "x.csv", { year: 2026, voyageId: "h" });
  const o = entries[0].observations!;
  assert.ok(inspection.recognisedFormat?.startsWith("pipe-delimited"));
  assert.equal(o.twsKn, 12);
  assert.equal(o.twdDeg, 157.5);
  assert.equal(o.sailPlan?.engine, false);
  assert.ok(Math.abs(o.position!.lon + 64.335) < 1e-3);
  assert.match(entries[0].timestampProvenance, /time zone not recorded/);
});

test("offline assistant recognises watch-change, route and logbook requests", async () => {
  const { interpretOffline } = await import("./assistant/assistant.js");
  assert.ok(interpretOffline("Let's do a watch change").intents.includes("watch_change"));
  assert.ok(interpretOffline("Let's update the route.").intents.includes("update_route"));
  assert.ok(interpretOffline("Show me the logbook").intents.includes("open_logbook"));
  const both = interpretOffline("The crew is exhausted. Let's prioritize comfort tonight.");
  assert.ok(both.intents.includes("preference") && both.intents.includes("log_report"));
});

test("chartplotter image reader rejects non-images before calling a model", async () => {
  const { extractFromImage } = await import("./logbook/extract.js");
  await assert.rejects(extractFromImage("hello"), /PNG, JPEG or WebP/);
});

test("offline parser reads fuel on board and burn rate", () => {
  const r = extractOffline("Motoring, 140 litres of diesel left, burning 3.2 l/h.");
  assert.equal(r.obs.fuelLitres, 140);
  assert.equal(r.obs.fuelBurnLph, 3.2);
});
