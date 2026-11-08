import L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { CircleMarker, GeoJSON, MapContainer, Marker, Polyline, Rectangle, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { ACCENT, api, compass, fmtTime, ROUTE_COLORS, type CandidateRoute, type GridPoint, type LogEntry, type RoutingResult } from "../api";

interface Props {
  routing: RoutingResult | null;
  selectedId: string | null; // SubQ recommendation (or captain choice)
  focusId: string | null; // route highlighted in the UI
  onFocus: (id: string | null) => void;
  vessel: { lat: number; lon: number; heading: number | null };
  destination: { lat: number; lon: number; label: string };
  timeIso: string;
  setTimeIso: (t: string) => void;
  timeRange: [number, number] | null;
  grid: GridPoint[];
  weatherInfo: string;
  replay: { entries: LogEntry[]; index: number } | null;
  onPick: (kind: "start" | "destination", p: { lat: number; lon: number }) => void;
  poolLegs?: { id: string; from: { lat: number; lon: number }; to: { lat: number; lon: number }; t: string; twsKn: number; waveHeightM: number | null; observedSogKn: number }[];
  poolHighlight?: string[];
}

// Quiet ink strokes for ordinary wind; only strong wind earns colour.
const windColor = (kn: number) => (kn >= 25 ? ACCENT : kn >= 18 ? "#4a555c" : kn >= 12 ? "#76828a" : "#a3adb3");

function windIcon(p: GridPoint) {
  const kn = p.twsKn ?? 0;
  const len = 10 + Math.min(24, kn);
  const rot = ((p.twdDeg ?? 0) + 180) % 360; // arrow points where the wind blows TO
  const c = windColor(kn);
  return L.divIcon({
    className: "",
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html: `<svg width="44" height="44" viewBox="-22 -22 44 44" style="transform:rotate(${rot}deg);overflow:visible">
      <line x1="0" y1="${len / 2}" x2="0" y2="${-len / 2}" stroke="${c}" stroke-width="1.2" stroke-linecap="round"/>
      <path d="M0 ${-len / 2 - 3.5} L-2.8 ${-len / 2 + 1.5} L2.8 ${-len / 2 + 1.5} Z" fill="${c}"/>
    </svg><div style="position:absolute;left:28px;top:14px;font:500 9px Geist Mono,ui-monospace,monospace;color:${c};opacity:.8">${Math.round(kn)}</div>`,
  });
}

function currentIcon(p: GridPoint) {
  const kn = p.currentKn ?? 0;
  const len = 6 + Math.min(16, kn * 20);
  return L.divIcon({
    className: "",
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    html: `<svg width="30" height="30" viewBox="-15 -15 30 30" style="transform:rotate(${p.currentDirDeg ?? 0}deg)"><line x1="0" y1="${len / 2}" x2="0" y2="${-len / 2}" stroke="#4f8a93" stroke-width="1.2" stroke-dasharray="2 2"/><path d="M0 ${-len / 2 - 3} L-2.5 ${-len / 2 + 1} L2.5 ${-len / 2 + 1} Z" fill="#4f8a93"/></svg>`,
  });
}

const boatIcon = (heading: number | null, color = "#1d2327") =>
  L.divIcon({
    className: "",
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    html: `<svg width="30" height="30" viewBox="-15 -15 30 30" style="transform:rotate(${heading ?? 0}deg);filter:drop-shadow(0 1px 2px rgba(29,35,39,.35))">
      <path d="M0 -12 C5 -5 5 5 3.5 10 L-3.5 10 C-5 5 -5 -5 0 -12 Z" fill="${color}" stroke="#fff" stroke-width="1.6"/>
      ${heading == null ? "" : '<line x1="0" y1="-12" x2="0" y2="-26" stroke="#1d2327" stroke-width="1" stroke-dasharray="2 2" opacity=".6"/>'}
    </svg>`,
  });

const destIcon = L.divIcon({
  className: "",
  iconSize: [26, 26],
  iconAnchor: [13, 13],
  html: `<svg width="26" height="26" viewBox="-13 -13 26 26"><circle r="8" fill="#fff" fill-opacity=".7" stroke="#1d2327" stroke-width="1.3"/><circle r="2.6" fill="${ACCENT}"/></svg>`,
});

function Graticule() {
  const lines = useMemo(() => {
    const out: { pts: [number, number][]; label: string; at: [number, number] }[] = [];
    for (let lat = -80; lat <= 80; lat += 5) out.push({ pts: [[lat, -180], [lat, 180]], label: `${Math.abs(lat)}°${lat >= 0 ? "N" : "S"}`, at: [lat, -179] });
    for (let lon = -180; lon <= 180; lon += 5) out.push({ pts: [[-85, lon], [85, lon]], label: `${Math.abs(lon)}°${lon >= 0 ? "E" : "W"}`, at: [0, lon] });
    return out;
  }, []);
  return (
    <>
      {lines.map((l, i) => (
        <Polyline key={i} positions={l.pts} pathOptions={{ color: "#1d2327", weight: 0.5, opacity: 0.08, interactive: false }} />
      ))}
    </>
  );
}

function GraticuleLabels() {
  const map = useMap();
  const [b, setB] = useState(map.getBounds());
  useMapEvents({ moveend: () => setB(map.getBounds()), zoomend: () => setB(map.getBounds()) });
  const labels: { pos: [number, number]; text: string }[] = [];
  const s = b.getSouth(), w = b.getWest();
  for (let lat = Math.ceil(s / 5) * 5; lat < b.getNorth(); lat += 5) labels.push({ pos: [lat, w], text: `${Math.abs(lat)}°${lat >= 0 ? "N" : "S"}` });
  for (let lon = Math.ceil(w / 5) * 5; lon < b.getEast(); lon += 5) labels.push({ pos: [s, lon], text: `${Math.abs(lon)}°${lon >= 0 ? "E" : "W"}` });
  return (
    <>
      {labels.map((l) => (
        <Marker key={l.text + l.pos.join()} position={l.pos} interactive={false}
          icon={L.divIcon({ className: "graticule-label", html: l.text, iconSize: [40, 14], iconAnchor: l.text.endsWith("N") || l.text.endsWith("S") ? [-4, 14] : [-3, 16] })} />
      ))}
    </>
  );
}

function FitOnce({ routing, vessel, destination }: { routing: RoutingResult | null; vessel: Props["vessel"]; destination: Props["destination"] }) {
  const map = useMap();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return;
    const pts: [number, number][] = [[vessel.lat, vessel.lon], [destination.lat, destination.lon]];
    routing?.routes.forEach((r) => r.track.forEach((p, i) => i % 6 === 0 && pts.push([p.lat, p.lon])));
    map.fitBounds(L.latLngBounds(pts).pad(0.12));
    setDone(true);
  }, [routing, vessel, destination, map, done]);
  return null;
}

function FitReplay({ track }: { track: [number, number][] }) {
  const map = useMap();
  const key = track.length ? `${track[0]}|${track.length}` : "";
  useEffect(() => { if (track.length > 1) map.fitBounds(L.latLngBounds(track).pad(0.1)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function PickHandler({ mode, onPick }: { mode: "start" | "destination" | null; onPick: (p: { lat: number; lon: number }) => void }) {
  useMapEvents({ click: (e) => mode && onPick({ lat: +e.latlng.lat.toFixed(4), lon: +e.latlng.lng.toFixed(4) }) });
  return null;
}

function positionAt(r: CandidateRoute, tMs: number): [number, number] | null {
  const tr = r.track;
  if (!tr.length || tMs < Date.parse(tr[0].t)) return null;
  for (let i = 1; i < tr.length; i++) {
    const t1 = Date.parse(tr[i].t);
    if (t1 >= tMs) {
      const t0 = Date.parse(tr[i - 1].t);
      const f = t1 === t0 ? 1 : (tMs - t0) / (t1 - t0);
      return [tr[i - 1].lat + (tr[i].lat - tr[i - 1].lat) * f, tr[i - 1].lon + (tr[i].lon - tr[i - 1].lon) * f];
    }
  }
  return [tr[tr.length - 1].lat, tr[tr.length - 1].lon];
}

export function MapView(p: Props) {
  const [land, setLand] = useState<any>(null);
  const [layers, setLayers] = useState({ wind: true, waves: true, currents: false, basemap: false });
  const [pick, setPick] = useState<"start" | "destination" | null>(null);
  useEffect(() => { api.land().then(setLand).catch(() => setLand(null)); }, []);

  const step = useMemo(() => {
    if (p.grid.length < 2) return 2;
    const lats = [...new Set(p.grid.map((g) => g.lat))].sort((a, b) => a - b);
    return lats.length > 1 ? lats[1] - lats[0] : 2;
  }, [p.grid]);
  const tMs = Date.parse(p.timeIso);
  const routes = p.routing?.routes ?? [];
  const ordered = [...routes].sort((a, b) => (a.id === p.selectedId ? 1 : 0) - (b.id === p.selectedId ? 1 : 0) || (a.id === p.focusId ? 1 : 0) - (b.id === p.focusId ? 1 : 0));
  const replayTrack = p.replay ? p.replay.entries.filter((e) => e.observations?.position).map((e) => [e.observations!.position!.lat, e.observations!.position!.lon] as [number, number]) : [];
  const replayEntry = p.replay?.entries[p.replay.index];
  const replayPos = p.replay ? p.replay.entries.slice(0, p.replay.index + 1).filter((e) => e.observations?.position).map((e) => [e.observations!.position!.lat, e.observations!.position!.lon] as [number, number]) : [];

  return (
    <div className="map-wrap">
      <MapContainer center={[p.vessel.lat, p.vessel.lon]} zoom={5} worldCopyJump zoomSnap={0.25} preferCanvas={false} attributionControl>
        {layers.basemap && (
          <TileLayer className="relief-tiles" url="https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}" attribution="Esri, GEBCO, NOAA" opacity={0.7} />
        )}
        <Graticule />
        <GraticuleLabels />
        {land && !layers.basemap && (
          <GeoJSON data={land} interactive={false} style={{ color: "#bdb5a5", weight: 0.7, fillColor: "#f2efe7", fillOpacity: 1 }} attribution="Coastline: Natural Earth 1:50m" />
        )}
        {layers.waves && p.grid.map((g) => g.waveHeightM != null && (
          <Rectangle key={`w${g.lat},${g.lon}`} bounds={[[g.lat - step / 2, g.lon - step / 2], [g.lat + step / 2, g.lon + step / 2]]} interactive={false}
            pathOptions={{ stroke: false, fillColor: g.waveHeightM > 3.5 ? "#c98f78" : "#7d9fb0", fillOpacity: Math.min(0.26, 0.02 + g.waveHeightM * 0.055) }} />
        ))}
        {layers.waves && p.grid.map((g) => g.waveHeightM != null && (
          <CircleMarker key={`wt${g.lat},${g.lon}`} center={[g.lat, g.lon]} radius={9} pathOptions={{ opacity: 0, fillOpacity: 0 }}>
            <Tooltip className="tack-tip" direction="top">
              Forecast {fmtTime(g.time)}<br />wind {g.twsKn ?? "—"} kn from {g.twdDeg ?? "—"}° {compass(g.twdDeg)} · gust {g.gustKn ?? "—"}<br />
              waves {g.waveHeightM} m / {g.wavePeriodS ?? "—"} s from {g.waveDirDeg ?? "—"}° · swell {g.swellHeightM ?? "—"} m<br />
              current {g.currentKn ?? "—"} kn → {g.currentDirDeg ?? "—"}°
            </Tooltip>
          </CircleMarker>
        ))}
        {layers.wind && p.grid.map((g) => g.twsKn != null && <Marker key={`a${g.lat},${g.lon}`} position={[g.lat, g.lon]} icon={windIcon(g)} interactive={false} />)}
        {layers.currents && p.grid.map((g) => g.currentKn != null && g.currentKn > 0.05 && (
          <Marker key={`c${g.lat},${g.lon}`} position={[g.lat - step * 0.25, g.lon + step * 0.25]} icon={currentIcon(g)} interactive={false} />
        ))}

        {!p.replay && ordered.map((r) => {
          const sel = r.id === p.selectedId;
          const foc = r.id === p.focusId;
          const color = sel ? ACCENT : foc ? "#1d2327" : ROUTE_COLORS[r.id] ?? "#8d9498";
          return (
            <Polyline key={r.id} positions={r.track.map((t) => [t.lat, t.lon] as [number, number])}
              eventHandlers={{ click: () => p.onFocus(r.id), mouseover: () => p.onFocus(r.id) }}
              pathOptions={{ color, weight: sel ? 3.2 : foc ? 2.4 : 1.4, opacity: sel || foc ? 1 : r.eligible ? 0.6 : 0.3, dashArray: r.eligible ? undefined : "1 5", lineCap: "round" }}>
              <Tooltip sticky className="tack-tip">
                <b>{r.id} {r.name}</b>{sel ? " — recommended" : ""}<br />
                ETA {fmtTime(r.metrics.etaIso)} · {r.metrics.distanceNm} nm · comfort {r.metrics.comfortIndex}/10<br />
                motoring {r.metrics.motoringHours} h · max wind {r.metrics.wind.maxKn} kn · max waves {r.metrics.waves.maxM ?? "—"} m
                {!r.eligible && <><br /><span style={{ color: "var(--warn)" }}>Excluded: {r.hardConstraintViolations.join("; ")}</span></>}
              </Tooltip>
            </Polyline>
          );
        })}
        {!p.replay && routes.map((r) => {
          const pos = positionAt(r, tMs);
          if (!pos) return null;
          const sel = r.id === p.selectedId;
          return <CircleMarker key={`p${r.id}`} center={pos} radius={sel ? 5 : 3.5} pathOptions={{ color: "#fff", weight: 1.5, fillColor: sel ? ACCENT : ROUTE_COLORS[r.id], fillOpacity: 1 }} />;
        })}

        {p.replay && (
          <>
            <FitReplay track={replayTrack} />
            <Polyline positions={replayTrack} pathOptions={{ color: "#6b5b95", weight: 1.2, opacity: 0.35, dashArray: "2 4" }} />
            <Polyline positions={replayPos} pathOptions={{ color: "#6b5b95", weight: 2.4, opacity: 0.9 }} />
            {replayEntry?.observations?.position && (
              <Marker position={[replayEntry.observations.position.lat, replayEntry.observations.position.lon]} icon={boatIcon(replayEntry.observations.cogDeg ?? replayEntry.observations.headingDeg, "#6b5b95")} />
            )}
          </>
        )}

        {(p.poolLegs ?? []).map((l) => {
          const hit = (p.poolHighlight ?? []).some((w) => w.slice(0, 13) === l.t.slice(0, 13));
          return (
            <Polyline key={l.id} positions={[[l.from.lat, l.from.lon], [l.to.lat, l.to.lon]]}
              pathOptions={{ color: hit ? ACCENT : "#8a7fb0", weight: hit ? 4 : 2, opacity: hit ? 1 : 0.6 }}>
              <Tooltip sticky className="tack-tip">
                Fleet memory (shared, anonymised){hit ? " — match" : ""}<br />{fmtTime(l.t)} · {l.observedSogKn.toFixed(1)} kn made good<br />
                archived forecast: {l.twsKn} kn, waves {l.waveHeightM ?? "—"} m<br />positions rounded to 0.5°
              </Tooltip>
            </Polyline>
          );
        })}
        {(p.poolLegs?.length ?? 0) > 0 && <FitReplay track={(p.poolLegs ?? []).flatMap((l) => [[l.from.lat, l.from.lon], [l.to.lat, l.to.lon]] as [number, number][])} />}

        {!p.replay && (
          <>
            <Marker position={[p.destination.lat, p.destination.lon]} icon={destIcon}><Tooltip className="tack-tip">{p.destination.label}</Tooltip></Marker>
            <Marker position={[p.vessel.lat, p.vessel.lon]} icon={boatIcon(p.vessel.heading)} />
          </>
        )}
        <FitOnce routing={p.routing} vessel={p.vessel} destination={p.destination} />
        <PickHandler mode={pick} onPick={(pt) => { if (pick) p.onPick(pick, pt); setPick(null); }} />
      </MapContainer>

      <div className="map-overlay map-layers">
        {(["wind", "waves", "currents"] as const).map((k) => (
          <button key={k} className={layers[k] ? "on" : ""} onClick={() => setLayers({ ...layers, [k]: !layers[k] })}>{k[0].toUpperCase() + k.slice(1)}</button>
        ))}
        <button className={layers.basemap ? "on" : ""} title="Esri ocean basemap — needs internet" onClick={() => setLayers({ ...layers, basemap: !layers.basemap })}>Relief</button>
        {!p.replay && <button className={pick === "start" ? "on" : ""} onClick={() => setPick(pick === "start" ? null : "start")}>Set start</button>}
        {!p.replay && <button className={pick === "destination" ? "on" : ""} onClick={() => setPick(pick === "destination" ? null : "destination")}>Set destination</button>}
      </div>

      {!p.replay && routes.length > 0 && (
        <div className="map-overlay map-legend">
          {routes.map((r) => (
            <div className={`row ${r.id === p.focusId ? "foc" : ""}`} key={r.id} style={{ opacity: r.eligible ? 1 : 0.45 }} onMouseEnter={() => p.onFocus(r.id)} onMouseLeave={() => p.onFocus(null)}>
              <span className="ln" style={{ background: r.id === p.selectedId ? ACCENT : ROUTE_COLORS[r.id] }} />
              {r.name}{r.id === p.selectedId ? <em> recommended</em> : ""}
            </div>
          ))}
        </div>
      )}
      {pick && <div className="map-overlay map-banner">Click the chart to set the {pick}</div>}
      {p.replay && replayEntry && (
        <div className="map-overlay map-banner replay">Replay · {fmtTime(replayEntry.timestamp)} · entry {p.replay.index + 1} of {p.replay.entries.length}</div>
      )}

      {!p.replay && p.timeRange && (
        <div className="map-overlay map-time">
          <span className="t">Forecast for {fmtTime(p.timeIso)}</span>
          <input type="range" min={p.timeRange[0]} max={p.timeRange[1]} step={3_600_000 * 3} value={tMs}
            onChange={(e) => p.setTimeIso(new Date(Number(e.target.value)).toISOString())} />
          <span className="src">{p.weatherInfo}</span>
        </div>
      )}
    </div>
  );
}
