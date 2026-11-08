import { useEffect, useMemo, useRef, useState } from "react";
import { api, compass, fmtClock, fmtDay, fmtPos, fmtTime, type LearnedCorrection, type LogEntry, type Voyage } from "../api";
import { FleetMemory, type PoolLeg } from "./FleetMemory";

/* The logbook as a sailing journal: a chronological timeline grouped by day, where each
   entry says when, where, who wrote it, what was seen, what was decided and what followed. */

interface Props {
  voyages: Voyage[];
  refreshKey: number;
  replay: { voyageId: string; index: number } | null;
  setReplay: (r: { voyageId: string; index: number } | null) => void;
  onEntries: (voyageId: string, entries: LogEntry[]) => void;
  onImported: () => void;
  fleetDefaults: { twsKn: number | null; waveHeightM: number | null };
  onPoolLegs: (legs: PoolLeg[]) => void;
  onPoolHighlight: (whens: string[]) => void;
}

export type Category = "captain" | "instrument" | "forecast" | "ai" | "recommendation" | "outcome" | "note";

export const CATEGORY: Record<Category, { label: string; plural: string }> = {
  captain: { label: "Captain", plural: "Captain" },
  instrument: { label: "Instruments", plural: "Instruments" },
  forecast: { label: "Forecast", plural: "Forecasts" },
  ai: { label: "Interpretation", plural: "Interpretations" },
  recommendation: { label: "Recommendation", plural: "Recommendations" },
  outcome: { label: "Outcome", plural: "Outcomes" },
  note: { label: "Note", plural: "Notes" },
};

export function categorize(e: LogEntry): Category {
  if (e.kind === "observation") {
    if (e.source.startsWith("import:") || e.source === "captain:form" || e.source === "captain:watch-form" || e.source === "captain:watch-image") return "instrument";
    return "captain";
  }
  if (e.kind === "preference") return "captain";
  if (e.kind === "decision") return e.source === "tack" ? "recommendation" : "outcome";
  const m = e.message ?? "";
  if (/forecast/i.test(m)) return "forecast";
  if (/feedback/i.test(m)) return "outcome";
  if (/re-interpret|sync/i.test(m)) return "ai";
  return "note";
}

function author(e: LogEntry): string {
  const s = e.source;
  if (s === "captain:watch-nl") return "Captain · watch change, in their words";
  if (s === "captain:watch-form") return "Captain · watch change, instruments entered";
  if (s === "captain:watch-image") return "Chartplotter photo · confirmed by captain";
  if (s === "captain:form") return "Captain · instrument form";
  if (s === "captain:assistant" || s === "captain:nl") return e.kind === "preference" ? "Captain · instruction" : "Captain · in conversation";
  if (s === "captain:action") return "Captain";
  if (s.startsWith("import:")) return `Deck log · ${s.slice(7)}`;
  if (e.kind === "decision") return e.decision?.engine ? `TACK TACK · ${e.decision.engine}` : "TACK TACK";
  if (/forecast/i.test(e.message ?? "")) return "TACK TACK · Open-Meteo";
  return "TACK TACK";
}

/** Human-readable readings. Only stated values appear. */
function readings(e: LogEntry): [string, string][] {
  const o = e.observations;
  if (!o) return [];
  const out: [string, string][] = [];
  if (o.headingDeg != null) out.push(["Heading", `${o.headingDeg}°`]);
  if (o.cogDeg != null) out.push(["COG", `${o.cogDeg}°`]);
  if (o.sogKn != null) out.push(["SOG", `${o.sogKn} kn`]);
  if (o.stwKn != null) out.push(["STW", `${o.stwKn} kn`]);
  if (o.twsKn != null || o.twdDeg != null) out.push(["Wind", `${o.twsKn != null ? `${o.twsKn} kn` : ""}${o.twdDeg != null ? ` from ${compass(o.twdDeg)} (${o.twdDeg}°)` : ""}`.trim()]);
  if (o.awaDeg != null) out.push(["AWA", `${o.awaDeg}°`]);
  if (o.gustKn != null) out.push(["Gusts", `${o.gustKn} kn`]);
  if (o.pressureHpa != null) out.push(["Barometer", `${o.pressureHpa} hPa`]);
  if (o.waveHeightM != null) out.push(["Waves", `${o.waveHeightM} m`]);
  if (o.seaState) out.push(["Sea", o.seaState]);
  if (o.sailPlan) {
    const sp = o.sailPlan;
    out.push(["Sails", sp.raw ?? ([sp.main !== "unknown" && `main ${sp.main}${sp.reefLevel ? ` (reef ${sp.reefLevel})` : ""}`, sp.headsail !== "unknown" && `headsail ${sp.headsail}`].filter(Boolean).join(", ") || "—")]);
    if (sp.engine != null) out.push(["Engine", sp.engine ? "running" : "off"]);
  }
  if (o.fuelLitres != null) out.push(["Fuel", `${o.fuelLitres} L`]);
  if (o.fuelBurnLph != null) out.push(["Burn", `${o.fuelBurnLph} L/h`]);
  if (o.crewCondition) out.push(["Crew", o.crewCondition]);
  if (o.tanks?.diesel) out.push(["Diesel", o.tanks.diesel]);
  if (o.tanks?.water) out.push(["Water", o.tanks.water]);
  return out;
}

function Entry({ e, cat, pos, posApprox, next, cur }: { e: LogEntry; cat: Category; pos: { lat: number; lon: number } | null; posApprox: boolean; next: string | null; cur?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (cur) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [cur]);
  const r = readings(e);
  const isImport = e.source.startsWith("import:");
  const words = e.kind === "preference" ? e.rawText : e.kind === "observation" && !isImport ? e.rawText : null;
  const remark = e.observations?.remarks && e.observations.remarks !== words ? e.observations.remarks : null;
  const interp = e.interpretation && (e.interpretation.seaState || e.interpretation.events.length > 0 || e.interpretation.crewMood) ? e.interpretation : null;
  const modelRead = e.extraction && e.kind === "observation" && !/form|csv-import|entered by captain/.test(e.extraction.method) ? e.extraction : null;
  return (
    <article ref={ref} className={`entry c-${cat} ${cur ? "cur" : ""}`}>
      <div className="when">{fmtClock(e.timestamp)}<small>UTC</small></div>
      <div className="dot" />
      <div className="body">
        <div className="byline">
          <span className="cat">{CATEGORY[cat].label}</span>
          <span>{author(e)}</span>
          {pos && <span className="pos" title={posApprox ? "Last known position before this entry" : "Position recorded with this entry"}>{posApprox ? "≈ " : ""}{fmtPos(pos)}</span>}
        </div>
        {words && <p className="words">“{words}”</p>}
        {isImport && remark && <p className="words">{remark}</p>}
        {(e.kind === "decision" || e.kind === "system") && e.message && <p className="msg">{e.message}</p>}
        {r.length > 0 && (
          <dl className="readout">{r.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        )}
        {!isImport && remark && <p className="remark">{remark}</p>}
        {e.kind === "preference" && e.preference && (
          <div className="interp"><span>TACK TACK read this as</span> {e.preference.change.summary}{e.preference.change.temporary ? ` — for ${Math.round(e.preference.change.temporary.durationHours)} h` : ""}</div>
        )}
        {interp && (
          <div className="interp">
            <span>Interpretation · {interp.method}</span>
            {[interp.seaState && `sea ${interp.seaState}`, interp.crewMood && `crew ${interp.crewMood}`, ...interp.events].filter(Boolean).join(" · ")}
          </div>
        )}
        {modelRead && (
          <div className="prov">
            Read by {modelRead.method} · {Math.round(modelRead.confidence * 100)}% confidence
            {modelRead.pendingModelReview && " · will be re-read when online"}
            {modelRead.notes.length > 0 && <> · {modelRead.notes.join(" · ")}</>}
          </div>
        )}
        {next && <div className="next"><span>What happened next</span> {next}</div>}
      </div>
    </article>
  );
}

const FILTERS: (Category | "all")[] = ["all", "captain", "instrument", "forecast", "ai", "recommendation", "outcome"];

export function Logbook(p: Props) {
  const historical = p.voyages.filter((v) => v.kind === "historical");
  const [tab, setTab] = useState<string>("live");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [filter, setFilter] = useState<Category | "all">("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const voyageId = tab === "learning" || tab === "fleet" ? null : tab;

  useEffect(() => {
    if (!voyageId) return;
    setLoading(true);
    api.logbook(voyageId).then((e) => { setEntries(e); p.onEntries(voyageId, e); }).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voyageId, p.refreshKey]);

  const obsEntries = useMemo(() => entries.filter((e) => e.kind === "observation"), [entries]);
  const replaying = !!p.replay && p.replay.voyageId === tab;

  useEffect(() => {
    if (!playing || !replaying) return;
    const t = setInterval(() => {
      const next = (p.replay!.index ?? 0) + 1;
      if (next >= obsEntries.length) { setPlaying(false); return; }
      p.setReplay({ voyageId: tab, index: next });
    }, 650);
    return () => clearInterval(t);
  }, [playing, replaying, p, obsEntries.length, tab]);

  // Derived journal: category, best-known position and "what happened next" for each entry.
  const journal = useMemo(() => {
    let lastPos: { lat: number; lon: number } | null = null;
    const out = entries.map((e, i) => {
      const own = e.observations?.position ?? null;
      if (own) lastPos = own;
      const cat = categorize(e);
      let next: string | null = null;
      if (cat === "recommendation" && e.decision) {
        const act = entries.slice(i + 1).find((x) => x.source === "captain:action" && x.decision?.id === e.decision!.id);
        const after = entries.slice(i + 1).find((x) => x.kind === "observation" && x.timestamp > (act?.timestamp ?? e.timestamp));
        const parts = [act ? `${act.message} (${fmtClock(act.timestamp)} UTC)` : "Not yet accepted or overridden."];
        if (after?.observations) {
          const o = after.observations;
          const bits = [o.sogKn != null && `${o.sogKn} kn`, o.twsKn != null && `wind ${o.twsKn} kn`, o.crewCondition && `crew ${o.crewCondition}`].filter(Boolean);
          parts.push(`Next report ${fmtTime(after.timestamp)}${bits.length ? `: ${bits.join(", ")}` : ""}.`);
        }
        next = parts.join(" ");
      }
      return { e, cat, pos: own ?? lastPos, posApprox: !own && !!lastPos, next, hasAi: !!(e.interpretation || e.kind === "preference" || (e.extraction && e.kind === "observation" && !/form|csv-import|entered by captain/.test(e.extraction.method))) };
    });
    return out;
  }, [entries]);

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

  const replayEntry = replaying ? obsEntries[p.replay!.index] : null;
  const shownBase = replaying
    ? journal.filter((j) => j.e.kind === "observation")
    : journal.filter((j) => filter === "all" || j.cat === filter || (filter === "ai" && j.hasAi));
  const shown = replaying || !newestFirst ? shownBase : [...shownBase].reverse();
  const days: { day: string; items: typeof shown }[] = [];
  for (const j of shown) {
    const d = fmtDay(j.e.timestamp);
    if (days.at(-1)?.day !== d) days.push({ day: d, items: [] });
    days.at(-1)!.items.push(j);
  }
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: journal.length };
    for (const j of journal) { c[j.cat] = (c[j.cat] ?? 0) + 1; if (j.hasAi && j.cat !== "ai") c.ai = (c.ai ?? 0) + 1; }
    return c;
  }, [journal]);

  const voyage = p.voyages.find((v) => v.id === tab);
  return (
    <div className="journal">
      <header className="journal-head">
        <h1>Logbook</h1>
        <nav className="voyages">
          <button className={tab === "live" ? "on" : ""} onClick={() => { setTab("live"); p.setReplay(null); setPlaying(false); }}>This passage</button>
          {historical.map((v) => <button key={v.id} className={tab === v.id ? "on" : ""} onClick={() => setTab(v.id)}>{v.name.replace(" (historical)", "").replace(/\.(csv|txt|json|psv)$/, "")}</button>)}
          <button className={tab === "learning" ? "on" : ""} onClick={() => setTab("learning")}>Boat performance</button>
          <button className={tab === "fleet" ? "on" : ""} onClick={() => { setTab("fleet"); p.setReplay(null); setPlaying(false); }}>Fleet memory</button>
        </nav>
        {voyage && tab !== "live" && <p className="fine-note">{voyage.notes}</p>}
      </header>

      {!!voyageId && !replaying && (
        <div className="journal-tools">
          <div className="filters">
            {FILTERS.map((f) => (counts[f] || f === "all") ? (
              <button key={f} className={`${filter === f ? "on" : ""} f-${f}`} onClick={() => setFilter(f)}>
                {f !== "all" && <i />}{f === "all" ? "Everything" : CATEGORY[f].plural}
              </button>
            ) : null)}
          </div>
          <div className="tools">
            <button className="link" onClick={() => setNewestFirst(!newestFirst)}>{newestFirst ? "Newest first" : "Oldest first"}</button>
            {voyageId && voyageId !== "live" && <button className="link" onClick={() => { p.setReplay({ voyageId, index: 0 }); setPlaying(true); }}>Replay on chart</button>}
            <label className="link">Import a log<input type="file" accept=".csv,.txt,.json,.psv" hidden onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} /></label>
          </div>
          {importing && <p className="fine-note">{importing}</p>}
        </div>
      )}

      {replaying && (
        <div className="replay-bar">
          <button className="btn quiet" onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
          <input type="range" min={0} max={obsEntries.length - 1} value={p.replay!.index} onChange={(e) => { setPlaying(false); p.setReplay({ voyageId: tab, index: Number(e.target.value) }); }} />
          <span>{fmtTime(replayEntry?.timestamp)}</span>
          <button className="link" onClick={() => { setPlaying(false); p.setReplay(null); }}>Exit replay</button>
        </div>
      )}

      <div className="journal-body">
        {tab === "fleet" ? (
          <FleetMemory voyages={p.voyages} defaults={p.fleetDefaults} onPool={p.onPoolLegs} onHighlight={p.onPoolHighlight} />
        ) : tab === "learning" ? (
          <Learning />
        ) : loading && !entries.length ? (
          <p className="muted">Opening the logbook…</p>
        ) : entries.length === 0 ? (
          <p className="muted">Nothing logged yet. Record a watch change or tell TACK TACK what’s happening aboard.</p>
        ) : (
          days.map((d) => (
            <section key={d.day} className="day">
              <h2>{d.day}</h2>
              {d.items.map((j) => <Entry key={j.e.id} e={j.e} cat={j.cat} pos={j.pos} posApprox={j.posApprox} next={j.next} cur={replaying && j.e.id === replayEntry?.id} />)}
            </section>
          ))
        )}
        {replaying && replayEntry && <ReplayLearning upTo={replayEntry.timestamp} />}
      </div>
    </div>
  );
}

function Learning({ upTo }: { upTo?: string } = {}) {
  const [c, setC] = useState<LearnedCorrection | null>(null);
  const [curves, setCurves] = useState<{ tws: number; points: { twa: number; base: number; learned: number }[] }[]>([]);
  const [polarInfo, setPolarInfo] = useState<string>("");
  useEffect(() => {
    api.learning(upTo).then(setC);
    api.polar().then((p) => { setCurves(p.curves); setPolarInfo(`${p.polar.name} (${p.polar.source}${p.polar.isSample ? " — SAMPLE" : ""})`); });
  }, [upTo]);
  if (!c) return <p className="muted">Loading…</p>;
  const twsBins = [...new Set(c.bins.map((b) => b.twsRange.join("–")))];
  const twaBins = [...new Set(c.bins.map((b) => b.twaRange.join("–")))];
  // polar plot (half-rose)
  const R = 120, maxV = 9;
  const xy = (twa: number, v: number) => [R * (v / maxV) * Math.sin((twa * Math.PI) / 180), -R * (v / maxV) * Math.cos((twa * Math.PI) / 180)];
  const colors = ["#8d9498", "#2f5d50", "#3e5c76", "#c2502e"];
  const upload = async (f: File) => { await api.uploadPolar(f.name, await f.text()); api.polar().then((p) => { setCurves(p.curves); setPolarInfo(p.polar.name); }); api.learning().then(setC); };
  return (
    <div className="learning">
      <div>
        <svg width="280" height="270" viewBox="-20 -130 160 270" style={{ display: "block" }}>
          {[3, 6, 9].map((v) => <path key={v} d={`M0 ${-R * v / maxV} A ${R * v / maxV} ${R * v / maxV} 0 0 1 0 ${R * v / maxV}`} fill="none" stroke="var(--line)" strokeWidth="0.6" />)}
          {[0, 45, 90, 135, 180].map((a) => { const [x, y] = xy(a, maxV); return <g key={a}><line x1="0" y1="0" x2={x} y2={y} stroke="var(--line)" strokeWidth="0.5" /><text x={x * 1.07} y={y * 1.07 + 3} fontSize="7" fill="#7d8789" textAnchor="middle">{a}°</text></g>; })}
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


/** Shows the learned correction as it stood at the replay position. */
function ReplayLearning({ upTo }: { upTo: string }) {
  const [c, setC] = useState<LearnedCorrection | null>(null);
  useEffect(() => { const t = setTimeout(() => api.learning(upTo).then(setC), 150); return () => clearTimeout(t); }, [upTo]);
  if (!c) return null;
  const withData = c.bins.filter((b) => b.samples);
  return (
    <div className="replay-learning">
      Learning so far: {c.summary.used} usable observations ·{" "}
      {withData.map((b) => `${b.twsRange.join("–")} kn/${b.twaRange.join("–")}° ×${b.factor.toFixed(3)} (n=${b.samples})`).join(" · ") || "no full-sail observations yet"}
    </div>
  );
}
