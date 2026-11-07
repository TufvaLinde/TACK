import { useEffect, useMemo, useRef, useState } from "react";
import { api, compass, fmtLat, fmtLon, fmtTime, type LearnedCorrection, type LogEntry, type Voyage } from "../api";

interface Props {
  voyages: Voyage[];
  refreshKey: number;
  replay: { voyageId: string; index: number } | null;
  setReplay: (r: { voyageId: string; index: number } | null) => void;
  onEntries: (voyageId: string, entries: LogEntry[]) => void;
  onImported: () => void;
}

function ObsChips({ e }: { e: LogEntry }) {
  const o = e.observations;
  if (!o) return null;
  const items: [string, string][] = [];
  if (o.position) items.push(["pos", `${fmtLat(o.position.lat)} ${fmtLon(o.position.lon)}`]);
  if (o.headingDeg != null) items.push(["hdg", `${o.headingDeg}°`]);
  if (o.cogDeg != null) items.push(["cog", `${o.cogDeg}°`]);
  if (o.sogKn != null) items.push(["sog", `${o.sogKn} kn`]);
  if (o.stwKn != null) items.push(["stw", `${o.stwKn} kn`]);
  if (o.twsKn != null || o.twdDeg != null) items.push(["wind", `${o.twsKn ?? "?"} kn ${o.twdDeg != null ? `${o.twdDeg}° ${compass(o.twdDeg)}` : ""}`]);
  if (o.pressureHpa != null) items.push(["baro", `${o.pressureHpa}`]);
  if (o.sailPlan) items.push(["sails", o.sailPlan.raw ?? `main ${o.sailPlan.main}, head ${o.sailPlan.headsail}${o.sailPlan.engine ? ", engine" : o.sailPlan.engine === false ? ", no engine" : ""}`]);
  if (o.seaState) items.push(["sea", o.seaState]);
  if (o.crewCondition) items.push(["crew", o.crewCondition]);
  if (o.tanks?.diesel) items.push(["diesel", o.tanks.diesel]);
  if (o.tanks?.water) items.push(["water", o.tanks.water]);
  return <div className="kv">{items.map(([k, v]) => <span key={k}>{k} <b>{v}</b></span>)}</div>;
}

function Row({ e, cur }: { e: LogEntry; cur?: boolean }) {
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => { if (cur) ref.current?.scrollIntoView({ block: "nearest" }); }, [cur]);
  const isImport = e.source.startsWith("import:");
  return (
    <tr ref={ref} className={`k-${e.kind} ${cur ? "cur" : ""}`}>
      <td className="mono">{fmtTime(e.timestamp)}</td>
      <td><span className={`kind ${e.kind}`}>{e.kind}</span></td>
      <td>
        {e.kind === "observation" && (isImport
          ? <div className="raw">{e.observations?.remarks ?? <span className="empty">no remark</span>}</div>
          : e.rawText && <div className="raw">“{e.rawText}”</div>)}
        {e.kind === "preference" && <div className="raw">“{e.rawText}”</div>}
        {e.kind === "preference" && e.preference && <div className="kv"><span>→ <b>{e.preference.change.summary}</b></span></div>}
        {(e.kind === "decision" || e.kind === "system") && <div>{e.message}</div>}
        <ObsChips e={e} />
        {e.interpretation && (e.interpretation.seaState || e.interpretation.events.length > 0 || e.interpretation.crewMood) && (
          <div className="kv" style={{ color: "#5a4380" }}>
            <span className="tag est">ai</span>
            {e.interpretation.seaState && <span>sea <b>{e.interpretation.seaState}</b></span>}
            {e.interpretation.crewMood && <span>mood <b>{e.interpretation.crewMood}</b></span>}
            {e.interpretation.events.map((x) => <span key={x}>{x}</span>)}
          </div>
        )}
        {e.extraction && (
          <div className="prov">
            {e.source} · {e.extraction.method} · confidence {(e.extraction.confidence * 100).toFixed(0)}%
            {e.extraction.missingFields.length > 0 && e.kind === "observation" && [e.observations?.position, e.observations?.sogKn, e.observations?.twsKn, e.observations?.headingDeg, e.observations?.cogDeg].some((v) => v != null) && <> · <span className="miss">not stated: {e.extraction.missingFields.join(", ")}</span></>}
            {e.extraction.pendingModelReview && <> · <span className="miss">pending re-interpretation when online</span></>}
            {e.extraction.notes.length > 0 && <> · {e.extraction.notes.join(" · ")}</>}
          </div>
        )}
      </td>
    </tr>
  );
}

function Learning({ upTo }: { upTo?: string }) {
  const [c, setC] = useState<LearnedCorrection | null>(null);
  const [curves, setCurves] = useState<{ tws: number; points: { twa: number; base: number; learned: number }[] }[]>([]);
  const [polarInfo, setPolarInfo] = useState<string>("");
  useEffect(() => {
    api.learning(upTo).then(setC);
    api.polar().then((p) => { setCurves(p.curves); setPolarInfo(`${p.polar.name} (${p.polar.source}${p.polar.isSample ? " — SAMPLE" : ""})`); });
  }, [upTo]);
  if (!c) return <div className="panel empty">Loading…</div>;
  const twsBins = [...new Set(c.bins.map((b) => b.twsRange.join("–")))];
  const twaBins = [...new Set(c.bins.map((b) => b.twaRange.join("–")))];
  // polar plot (half-rose)
  const R = 120, maxV = 9;
  const xy = (twa: number, v: number) => [R * (v / maxV) * Math.sin((twa * Math.PI) / 180), -R * (v / maxV) * Math.cos((twa * Math.PI) / 180)];
  const colors = ["#7d8789", "#3f7d6e", "#2f5476", "#d9733a"];
  const upload = async (f: File) => { await api.uploadPolar(f.name, await f.text()); api.polar().then((p) => { setCurves(p.curves); setPolarInfo(p.polar.name); }); api.learning().then(setC); };
  return (
    <div className="learning">
      <div>
        <svg width="280" height="270" viewBox="-20 -130 160 270" style={{ display: "block" }}>
          {[3, 6, 9].map((v) => <path key={v} d={`M0 ${-R * v / maxV} A ${R * v / maxV} ${R * v / maxV} 0 0 1 0 ${R * v / maxV}`} fill="none" stroke="#d6caad" strokeWidth="0.6" />)}
          {[0, 45, 90, 135, 180].map((a) => { const [x, y] = xy(a, maxV); return <g key={a}><line x1="0" y1="0" x2={x} y2={y} stroke="#d6caad" strokeWidth="0.5" /><text x={x * 1.07} y={y * 1.07 + 3} fontSize="7" fill="#7d8789" textAnchor="middle">{a}°</text></g>; })}
          {curves.map((cv, i) => (
            <g key={cv.tws}>
              <polyline fill="none" stroke={colors[i]} strokeWidth="0.9" strokeDasharray="2 2" points={cv.points.map((p) => xy(p.twa, p.base).join(",")).join(" ")} />
              <polyline fill="none" stroke={colors[i]} strokeWidth="1.6" points={cv.points.map((p) => xy(p.twa, p.learned).join(",")).join(" ")} />
              <text x="100" y={-118 + i * 10} fontSize="7" fill={colors[i]}>— {cv.tws} kn</text>
            </g>
          ))}
          <text x="100" y="-74" fontSize="6.5" fill="#7d8789">dashed: baseline</text>
          <text x="100" y="-66" fontSize="6.5" fill="#7d8789">solid: × learned</text>
        </svg>
        <div className="prov">{polarInfo}</div>
        <label className="btn ghost sm" style={{ display: "inline-block", marginTop: 6 }}>Load polar CSV/JSON<input type="file" accept=".csv,.json,.txt,.pol" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
      </div>
      <div>
        <h3 style={{ marginBottom: 6 }}>Learned performance correction {upTo && <span className="tag hist">up to {fmtTime(upTo)}</span>}</h3>
        <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 8 }}>
          {c.summary.considered} observations compared with the baseline polar · <b>{c.summary.used} used</b> (full sail, no engine) · {c.summary.excluded} excluded.
          Each bin factor is shrunk toward 1.0 (prior strength {c.priorStrength}) and weighted by data quality, so a few noisy logs cannot rewrite the polar.
        </div>
        <table className="bins">
          <thead><tr><th>TWS \ TWA</th>{twaBins.map((a) => <th key={a}>{a}°</th>)}</tr></thead>
          <tbody>
            {twsBins.map((s) => (
              <tr key={s}>
                <th>{s} kn</th>
                {twaBins.map((a) => {
                  const b = c.bins.find((x) => x.twsRange.join("–") === s && x.twaRange.join("–") === a)!;
                  return (
                    <td key={a} className={b.samples ? "has" : ""} style={{ background: b.samples ? (b.factor < 1 ? `rgba(181,72,43,${Math.min(0.3, (1 - b.factor) * 3)})` : `rgba(63,125,110,${Math.min(0.3, (b.factor - 1) * 3)})`) : undefined }}>
                      {b.samples ? `×${b.factor.toFixed(3)}` : "·"}
                      {b.samples > 0 && <small>n={b.samples} · obs/pred {b.meanRatio.toFixed(2)}{b.stdErr != null ? ` ±${b.stdErr.toFixed(2)}` : ""}</small>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="prov" style={{ marginTop: 8 }}>
          Excluded: {Object.entries(c.summary.exclusionReasons).map(([k, v]) => `${k} (${v})`).join(" · ") || "none"}<br />
          By configuration (descriptive, mean observed/predicted): {Object.entries(c.byConfig).map(([k, v]) => `${k} ${v.meanRatio.toFixed(2)} (n=${v.samples})`).join(" · ")}<br />
          Speed-over-ground observations carry current and leeway; wind reference was not recorded — these reduce each observation's weight.
        </div>
      </div>
    </div>
  );
}

export function Logbook(p: Props) {
  const historical = p.voyages.filter((v) => v.kind === "historical");
  const [tab, setTab] = useState<string>("live");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const voyageId = tab === "learning" ? null : tab;

  useEffect(() => {
    if (!voyageId) return;
    setLoading(true);
    api.logbook(voyageId).then((e) => { setEntries(e); p.onEntries(voyageId, e); }).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voyageId, p.refreshKey]);

  const obsEntries = useMemo(() => entries.filter((e) => e.kind === "observation"), [entries]);
  const replaying = p.replay && p.replay.voyageId === tab;

  useEffect(() => {
    if (!playing || !replaying) return;
    const t = setInterval(() => {
      const next = (p.replay!.index ?? 0) + 1;
      if (next >= obsEntries.length) { setPlaying(false); return; }
      p.setReplay({ voyageId: tab, index: next });
    }, 650);
    return () => clearInterval(t);
  }, [playing, replaying, p, obsEntries.length, tab]);

  const doImport = async (f: File) => {
    setImporting(`Importing ${f.name} and interpreting remarks…`);
    try {
      const r = await api.importLog(f.name, await f.text(), 2026);
      setImporting(`Imported ${r.imported} entries · ${r.interpretation}`);
      p.onImported();
      setTab(r.voyageId);
    } catch (e) {
      setImporting(`Import failed: ${(e as Error).message}`);
    }
  };

  const shown = replaying ? obsEntries : [...entries].reverse();
  return (
    <div className="logbook">
      <div className="log-tabs">
        <button className={`tab ${tab === "live" ? "on" : ""}`} onClick={() => { setTab("live"); p.setReplay(null); setPlaying(false); }}>Logbook</button>
        {historical.map((v) => (
          <button key={v.id} className={`tab ${tab === v.id ? "on" : ""}`} onClick={() => { setTab(v.id); }}>{v.name.replace(" (historical)", "")}</button>
        ))}
        <button className={`tab ${tab === "learning" ? "on" : ""}`} onClick={() => setTab("learning")}>Performance</button>
        <div className="tools">
          {importing && <span className="prov">{importing}</span>}
          {voyageId && voyageId !== "live" && !replaying && <button className="btn sm" onClick={() => { p.setReplay({ voyageId, index: 0 }); setPlaying(true); }}>▶ Replay voyage</button>}
          <label className="btn ghost sm">Import log<input type="file" accept=".csv,.txt,.json,.psv" hidden onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} /></label>
        </div>
      </div>
      {replaying && (
        <div className="replay-bar">
          <button className="btn sm" onClick={() => setPlaying(!playing)}>{playing ? "❚❚" : "▶"}</button>
          <input type="range" min={0} max={obsEntries.length - 1} value={p.replay!.index} onChange={(e) => { setPlaying(false); p.setReplay({ voyageId: tab, index: Number(e.target.value) }); }} />
          <span>{fmtTime(obsEntries[p.replay!.index]?.timestamp)}</span>
          <button className="btn ghost sm" onClick={() => { setPlaying(false); p.setReplay(null); }}>exit replay</button>
        </div>
      )}
      <div className="log-body">
        {tab === "learning" ? (
          <Learning upTo={replaying ? undefined : undefined} />
        ) : loading && !entries.length ? (
          <div className="panel empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="panel empty">No entries yet. Send a watch report through the assistant, or import a historical log.</div>
        ) : (
          <table className="log-table">
            <thead><tr><th style={{ width: 120 }}>Time (UTC)</th><th style={{ width: 90 }}>Kind</th><th>Entry</th></tr></thead>
            <tbody>{shown.map((e, i) => <Row key={e.id} e={e} cur={!!replaying && i === p.replay!.index} />)}</tbody>
          </table>
        )}
        {replaying && tab !== "learning" && obsEntries[p.replay!.index] && (
          <ReplayLearning upTo={obsEntries[p.replay!.index].timestamp} />
        )}
      </div>
    </div>
  );
}

/** Shows the learned correction as it stood at the replay position. */
function ReplayLearning({ upTo }: { upTo: string }) {
  const [c, setC] = useState<LearnedCorrection | null>(null);
  useEffect(() => { const t = setTimeout(() => api.learning(upTo).then(setC), 150); return () => clearTimeout(t); }, [upTo]);
  if (!c) return null;
  const withData = c.bins.filter((b) => b.samples);
  return (
    <div style={{ position: "sticky", bottom: 0, background: "#f1ebf7", borderTop: "1px solid var(--rule)", padding: "6px 12px", font: "400 11px var(--mono)" }}>
      Learning so far: {c.summary.used} usable observations ·{" "}
      {withData.map((b) => `${b.twsRange.join("–")} kn/${b.twaRange.join("–")}° ×${b.factor.toFixed(3)} (n=${b.samples})`).join(" · ") || "no full-sail observations yet"}
    </div>
  );
}
