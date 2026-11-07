import fs from "node:fs";
import path from "node:path";
import type { LatLon } from "../../shared/types.js";
import { config } from "../config.js";

const R_NM = 3440.065;
const rad = Math.PI / 180;
const deg = 180 / Math.PI;

export function distanceNm(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) * deg + 360) % 360;
}

export function destination(a: LatLon, bearing: number, distNm: number): LatLon {
  const d = distNm / R_NM;
  const b = bearing * rad;
  const lat1 = a.lat * rad;
  const lon1 = a.lon * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * deg, lon: ((lon2 * deg + 540) % 360) - 180 };
}

/** Intermediate point on the great circle at fraction f. */
export function interpolateGC(a: LatLon, b: LatLon, f: number): LatLon {
  const d = distanceNm(a, b);
  return destination(a, bearingDeg(a, b), d * f);
}

/** Smallest signed angle difference a−b in (−180, 180]. */
export function angleDiff(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/* ─────────── Land mask (Natural Earth 1:50m, bundled locally for offline use) ─────────── */

type Ring = number[][];
type Edge = [number, number, number, number];
const BAND = 0.5; // degrees of latitude per edge bucket
interface BandedRing { bands: Map<number, Edge[]> }
interface Poly { bbox: [number, number, number, number]; rings: BandedRing[] }
let polys: Poly[] | null = null;

function bandRing(ring: Ring): BandedRing {
  const bands = new Map<number, Edge[]>();
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j], [x2, y2] = ring[i];
    if (y1 === y2) continue;
    for (let b = Math.floor(Math.min(y1, y2) / BAND); b <= Math.floor(Math.max(y1, y2) / BAND); b++) {
      if (!bands.has(b)) bands.set(b, []);
      bands.get(b)!.push([x1, y1, x2, y2]);
    }
  }
  return { bands };
}

function loadLand(): Poly[] {
  if (polys) return polys;
  const file = path.join(config.dataDir, "geo", "land-50m.geojson");
  const gj = JSON.parse(fs.readFileSync(file, "utf8"));
  polys = [];
  for (const f of gj.features) {
    const g = f.geometry;
    const list: Ring[][] = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    for (const rings of list) {
      let w = 180, s = 90, e = -180, n = -90;
      for (const [x, y] of rings[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
      polys.push({ bbox: [w, s, e, n], rings: rings.map(bandRing) });
    }
  }
  return polys;
}

function inRing(x: number, y: number, ring: BandedRing): boolean {
  let inside = false;
  for (const [x1, y1, x2, y2] of ring.bands.get(Math.floor(y / BAND)) ?? []) {
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

// 2° bucket index so each lookup only tests nearby polygons.
let index: Map<string, Poly[]> | null = null;
const cellKey = (lon: number, lat: number) => `${Math.floor(lon / 2)}:${Math.floor(lat / 2)}`;
function landIndex(): Map<string, Poly[]> {
  if (index) return index;
  index = new Map();
  for (const poly of loadLand()) {
    const [w, s, e, n] = poly.bbox;
    for (let x = Math.floor(w / 2); x <= Math.floor(e / 2); x++)
      for (let y = Math.floor(s / 2); y <= Math.floor(n / 2); y++) {
        const k = `${x}:${y}`;
        if (!index.has(k)) index.set(k, []);
        index.get(k)!.push(poly);
      }
  }
  return index;
}

export function isLand(p: LatLon): boolean {
  for (const poly of landIndex().get(cellKey(p.lon, p.lat)) ?? []) {
    const [w, s, e, n] = poly.bbox;
    if (p.lon < w || p.lon > e || p.lat < s || p.lat > n) continue;
    if (inRing(p.lon, p.lat, poly.rings[0]) && !poly.rings.slice(1).some((h) => inRing(p.lon, p.lat, h))) return true;
  }
  return false;
}

/** Sample a segment every `stepNm` and report whether it touches land. */
export function segmentCrossesLand(a: LatLon, b: LatLon, stepNm = 3): boolean {
  const d = distanceNm(a, b);
  const n = Math.max(1, Math.ceil(d / stepNm));
  for (let i = 1; i < n; i++) if (isLand(interpolateGC(a, b, i / n))) return true;
  return false;
}
