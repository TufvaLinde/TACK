import fs from "node:fs";
import path from "node:path";
import type { PolarTable } from "../../shared/types.js";
import { config } from "../config.js";

/** Parse a polar from CSV (first row = TWS, first column = TWA; , ; or tab separated). */
export function parsePolarCsv(text: string, name: string, source: string): PolarTable {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/[,;\t]/).map((c) => c.trim()));
  if (rows.length < 3) throw new Error("Polar CSV needs a header row and at least two TWA rows");
  const tws = rows[0].slice(1).map(Number);
  if (tws.some((v) => !Number.isFinite(v))) throw new Error("Polar CSV header must contain numeric TWS values");
  const twa: number[] = [];
  const speeds: number[][] = [];
  for (const r of rows.slice(1)) {
    const a = Number(r[0]);
    if (!Number.isFinite(a)) throw new Error(`Bad TWA value "${r[0]}"`);
    const s = r.slice(1).map((c) => (c === "" ? 0 : Number(c)));
    if (s.length !== tws.length || s.some((v) => !Number.isFinite(v)))
      throw new Error(`Row TWA=${a} has ${s.length} values, expected ${tws.length}`);
    twa.push(a);
    speeds.push(s);
  }
  return normalise({ name, source, isSample: /sample/i.test(name + source), tws, twa, speeds });
}

/** JSON format: { name?, tws: number[], twa: number[], speeds: number[twa][tws] } */
export function parsePolarJson(text: string, name: string, source: string): PolarTable {
  const j = JSON.parse(text);
  if (!Array.isArray(j.tws) || !Array.isArray(j.twa) || !Array.isArray(j.speeds))
    throw new Error("Polar JSON must contain tws[], twa[] and speeds[twa][tws]");
  return normalise({ name: j.name ?? name, source, isSample: Boolean(j.isSample), tws: j.tws, twa: j.twa, speeds: j.speeds });
}

function normalise(p: PolarTable): PolarTable {
  // Ensure 0 TWS / no-go 0° anchors exist so interpolation behaves at the edges.
  if (p.tws[0] !== 0) {
    p.tws = [0, ...p.tws];
    p.speeds = p.speeds.map((r) => [0, ...r]);
  }
  if (p.twa[0] !== 0) {
    p.twa = [0, ...p.twa];
    p.speeds = [p.tws.map(() => 0), ...p.speeds];
  }
  return p;
}

export function loadPolar(file: string): PolarTable {
  const full = path.isAbsolute(file) ? file : path.join(config.dataDir, file);
  const text = fs.readFileSync(full, "utf8");
  const name = path.basename(full);
  return full.endsWith(".json") ? parsePolarJson(text, name, file) : parsePolarCsv(text, name, file);
}

function bracket(arr: number[], v: number): [number, number, number] {
  if (v <= arr[0]) return [0, 0, 0];
  const last = arr.length - 1;
  if (v >= arr[last]) return [last, last, 0];
  let i = 0;
  while (arr[i + 1] < v) i++;
  return [i, i + 1, (v - arr[i]) / (arr[i + 1] - arr[i])];
}

/** Bilinear interpolation of baseline boat speed (kn). TWA is folded to 0..180. */
export function polarSpeed(p: PolarTable, twsKn: number, twaDeg: number): number {
  let a = Math.abs(((twaDeg % 360) + 360) % 360);
  if (a > 180) a = 360 - a;
  const tws = Math.max(0, twsKn);
  const [i0, i1, fa] = bracket(p.twa, a);
  const [j0, j1, fs] = bracket(p.tws, tws);
  const s00 = p.speeds[i0][j0], s01 = p.speeds[i0][j1], s10 = p.speeds[i1][j0], s11 = p.speeds[i1][j1];
  let v = (1 - fa) * ((1 - fs) * s00 + fs * s01) + fa * ((1 - fs) * s10 + fs * s11);
  // Above the polar's max TWS, hold the last column (no extrapolation upward).
  return Math.max(0, v);
}

/** Optimal upwind / downwind VMG angles for a given TWS. */
export function vmgAngles(p: PolarTable, twsKn: number): { up: number; down: number } {
  let up = 45, bestUp = -Infinity, down = 150, bestDown = -Infinity;
  for (let a = 30; a <= 180; a += 1) {
    const s = polarSpeed(p, twsKn, a);
    const vmg = s * Math.cos((a * Math.PI) / 180);
    if (a <= 90 && vmg > bestUp) { bestUp = vmg; up = a; }
    if (a >= 90 && -vmg > bestDown) { bestDown = -vmg; down = a; }
  }
  return { up, down };
}

/**
 * Best achievable speed along a course at the given TWA, allowing tacking or gybing.
 * Returns the speed made good along the course and the angle actually sailed.
 */
export function effectiveCourseSpeed(
  speedAt: (tws: number, twa: number) => number,
  p: PolarTable,
  twsKn: number,
  courseTwaDeg: number,
  minUpwindTwa = 0,
): { vmc: number; sailedTwa: number; manoeuvre: "direct" | "tacking" | "gybing" } {
  const theta = Math.min(180, Math.abs(courseTwaDeg));
  const angles = vmgAngles(p, twsKn);
  const up = Math.max(angles.up, minUpwindTwa);
  const down = angles.down;
  // A course inside the (possibly widened) upwind angle cannot be sailed directly.
  const direct = theta < up ? 0 : speedAt(twsKn, theta);
  let best = { vmc: direct, sailedTwa: theta, manoeuvre: "direct" as const as "direct" | "tacking" | "gybing" };
  const rad = Math.PI / 180;
  if (theta < up) {
    const v = (speedAt(twsKn, up) * Math.cos(up * rad)) / Math.cos(theta * rad);
    if (v > best.vmc) best = { vmc: v, sailedTwa: up, manoeuvre: "tacking" };
  }
  if (theta > down) {
    const v = (speedAt(twsKn, down) * Math.abs(Math.cos(down * rad))) / Math.abs(Math.cos(theta * rad));
    if (v > best.vmc) best = { vmc: v, sailedTwa: down, manoeuvre: "gybing" };
  }
  return best;
}
