import { useState } from "react";
import {
  ACCENT, api, compass, fmtDur, fmtLat, fmtLon, fmtTime, ROUTE_COLORS,
  type AppState, type DecisionRecord, type LogEntry, type PlanStep, type RoutingResult,
} from "../api";

/* ───────────────────────── Vessel status ───────────────────────── */

function Inst({ label, value, unit, tag, meta, wide }: { label: string; value: React.ReactNode; unit?: string; tag?: { kind: string; text: string }; meta?: string; wide?: boolean }) {
  const none = value == null || value === "—";
  return (
    <div className={`inst ${wide ? "wide" : ""}`}>
      <div className="lbl"><span>{label}</span>{tag && <span className={`tag ${tag.kind}`}>{tag.text}</span>}</div>
      <div className={`val ${none ? "none" : ""}`}>{none ? "not reported" : value}{!none && unit && <small>{unit}</small>}</div>
      {meta && <div className="meta">{meta}</div>}
    </div>
  );
}

export function VesselPanel({ state, replayEntry }: { state: AppState; replayEntry: LogEntry | null }) {
  if (replayEntry) {
    const o = replayEntry.observations!;
    const hist = { kind: "hist", text: "log" };
    return (
      <section className="panel">
        <h2>Vessel <span className="h-aside">replay · {fmtTime(replayEntry.timestamp)}</span></h2>
        <div className="instruments">
          <Inst wide label="Position" tag={hist} value={o.position ? `${fmtLat(o.position.lat)}  ${fmtLon(o.position.lon)}` : "—"} meta={replayEntry.timestampProvenance} />
          <Inst label="COG" tag={hist} value={o.cogDeg ?? "—"} unit="°" />
          <Inst label="SOG" tag={hist} value={o.sogKn ?? "—"} unit="kn" />
          <Inst label="Wind" tag={hist} value={o.twsKn != null ? `${o.twsKn}` : o.twdDeg != null ? "dir only" : "—"} unit={o.twsKn != null ? `kn ${compass(o.twdDeg)}` : ""} meta="reference not recorded" />
          <Inst label="Pressure" tag={hist} value={o.pressureHpa ?? "—"} unit="hPa" />
          <Inst label="Sails" tag={hist} value={o.sailPlan?.raw ?? "—"} meta="M main · G genoa · E engine" />
          <Inst label="Sea state" tag={replayEntry.interpretation?.seaState ? { kind: "est", text: "ai" } : undefined} value={replayEntry.interpretation?.seaState ?? "—"} meta={replayEntry.interpretation ? `from remarks (${replayEntry.interpretation.method})` : undefined} />
          <Inst wide label="Remarks" value={o.remarks ? <span style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 14, whiteSpace: "normal" }}>{o.remarks}</span> : "—"} />
        </div>
      </section>
    );
  }
  const vs = state.vesselState;
  const ob = vs.observed;
  const obsTag = (o: { at: string } | null) => (o ? { kind: "obs", text: fmtTime(o.at, false) } : undefined);
  const fc = vs.forecastHere;
  const sp = ob.sailPlan?.value as any;
  return (
    <section className="panel">
      <h2>Vessel <span className="h-aside">{state.vessel.name}</span></h2>
      <div className="instruments">
        <Inst wide label="Position" tag={vs.position.at ? { kind: "obs", text: `observed ${fmtTime(vs.position.at, false)}` } : { kind: "muted", text: "configured" }}
          value={`${fmtLat(vs.position.lat)}  ${fmtLon(vs.position.lon)}`} meta={vs.position.source} />
        <Inst label="Heading" tag={obsTag(ob.headingDeg)} value={ob.headingDeg?.value ?? "—"} unit="°" />
        <Inst label="SOG" tag={obsTag(ob.sogKn)} value={ob.sogKn?.value ?? "—"} unit="kn" />
        <Inst label="STW" tag={obsTag(ob.stwKn)} value={ob.stwKn?.value ?? "—"} unit="kn" />
        <Inst label="Wind (obs)" tag={obsTag(ob.twsKn)} value={ob.twsKn ? `${ob.twsKn.value}` : "—"} unit={ob.twsKn ? `kn ${ob.twdDeg ? `${ob.twdDeg.value}°` : ""}` : ""} />
        <Inst label="Wind (fcst)" tag={fc ? { kind: "fcst", text: "fcst" } : undefined} value={fc?.twsKn ?? "—"} unit={fc ? `kn ${fc.twdDeg}° ${compass(fc.twdDeg)}` : ""} meta={fc ? `gusts ${fc.gustKn} kn` : "no forecast"} />
        <Inst label="Waves (fcst)" tag={fc ? { kind: "fcst", text: "fcst" } : undefined} value={fc?.waveHeightM ?? "—"} unit={fc ? `m ${fc.wavePeriodS ?? "—"}s` : ""} meta={fc ? `swell ${fc.swellHeightM ?? "—"} m · current ${fc.currentKn ?? "—"} kn` : undefined} />
        <Inst label="Sails" tag={obsTag(ob.sailPlan)} value={sp ? `${sp.main === "full" ? "M" : sp.main === "reefed" ? `M·R${sp.reefLevel ?? ""}` : "–"}${sp.headsail === "full" ? "+G" : sp.headsail === "reefed" ? "+G(r)" : ""}${sp.engine ? "+E" : ""}` : "—"}
          meta={sp ? `main ${sp.main} · headsail ${sp.headsail}${sp.engine ? " · engine" : sp.engine === false ? " · no engine" : ""}` : undefined} />
        <Inst label="Crew" tag={obsTag(ob.crewCondition)} value={ob.crewCondition?.value ?? "—"} />
        <Inst wide label="ETA" tag={vs.eta ? { kind: "est", text: "estimate" } : undefined} value={vs.eta?.etaIso ? fmtTime(vs.eta.etaIso) : "—"}
          meta={vs.eta ? `via ${vs.eta.routeId} ${vs.eta.routeName}${vs.eta.captainAccepted ? " (captain accepted)" : " (recommended, not yet accepted)"}` : "plan a route to estimate"} />
      </div>
    </section>
  );
}

/* ───────────────────────── Objectives ───────────────────────── */

const LABELS: Record<string, string> = { speed: "Speed", comfort: "Comfort", fuel: "Fuel", scenic: "Scenic", sailing: "Sailing", morale: "Morale" };

export function ObjectivesPanel({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const eff = state.effectiveObjectives;
  const base = state.objectives.base;
  const [edit, setEdit] = useState(false);
  const [deadline, setDeadline] = useState(eff.hard.arrivalDeadline?.slice(0, 16) ?? "");
  const [maxTws, setMaxTws] = useState(eff.hard.maxTwsKn?.toString() ?? "");
  const [maxWave, setMaxWave] = useState(eff.hard.maxWaveM?.toString() ?? "");
  const save = async () => {
    await api.objectives({ hard: { arrivalDeadline: deadline ? new Date(deadline + "Z").toISOString() : null, maxTwsKn: maxTws ? Number(maxTws) : null, maxWaveM: maxWave ? Number(maxWave) : null } });
    setEdit(false);
    onChanged();
  };
  return (
    <section className="panel">
      <h2>Objectives <span className="h-aside"><button className="btn ghost sm" onClick={() => setEdit(!edit)}>{edit ? "close" : "edit limits"}</button> <button className="btn ghost sm" onClick={async () => { await api.objectives({ reset: true }); onChanged(); }}>reset</button></span></h2>
      <div style={{ font: "600 10px var(--sans)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>Hard constraints</div>
      <div className="constraint"><span>Arrival deadline</span><span>{eff.hard.arrivalDeadline ? fmtTime(eff.hard.arrivalDeadline) : "none"}</span></div>
      <div className="constraint"><span>Max wind</span><span>{Math.min(eff.hard.maxTwsKn ?? Infinity, state.vessel.operationalLimits.maxTwsKn)} kn{eff.hard.maxTwsKn ? "" : " (vessel)"}</span></div>
      <div className="constraint"><span>Max waves</span><span>{Math.min(eff.hard.maxWaveM ?? Infinity, state.vessel.operationalLimits.maxWaveM)} m{eff.hard.maxWaveM ? "" : " (vessel)"}</span></div>
      {eff.hard.restrictedAreas.map((a) => <div className="constraint" key={a.name}><span>Avoid {a.name}</span><span>{a.radiusNm} nm</span></div>)}
      {eff.hard.other.map((o) => <div className="constraint" key={o}><span>{o}</span><span /></div>)}
      {edit && (
        <div style={{ marginTop: 6 }}>
          <div className="form-row"><label>Deadline (UTC)</label><input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></div>
          <div className="form-row"><label>Max wind kn</label><input value={maxTws} onChange={(e) => setMaxTws(e.target.value)} placeholder={`${state.vessel.operationalLimits.maxTwsKn}`} /></div>
          <div className="form-row"><label>Max waves m</label><input value={maxWave} onChange={(e) => setMaxWave(e.target.value)} placeholder={`${state.vessel.operationalLimits.maxWaveM}`} /></div>
          <button className="btn sm" onClick={save}>Save limits</button>
        </div>
      )}
      <div style={{ font: "600 10px var(--sans)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-3)", margin: "12px 0 6px" }}>Soft priorities</div>
      <div className="weights">
        {Object.entries(eff.weights).map(([k, v]) => {
          const tmp = v !== base[k as keyof typeof base];
          return (
            <div key={k} style={{ display: "contents" }}>
              <span>{LABELS[k]}</span>
              <span className="bar"><i className={tmp ? "tmp" : ""} style={{ width: `${v * 100}%` }} /></span>
              <span className="num">{v.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
      {eff.activeTemporary.map((t) => (
        <div className="tmp-obj" key={t.id}>“{t.text}”<div className="exp">temporary · expires {fmtTime(t.expiresAt)}</div></div>
      ))}
    </section>
  );
}

/* ───────────────────────── Candidate routes ───────────────────────── */

export function RoutesPanel({ routing, selectedId, focusId, onFocus }: { routing: RoutingResult | null; selectedId: string | null; focusId: string | null; onFocus: (id: string | null) => void }) {
  return (
    <section className="panel">
      <h2>Candidate routes {routing && <span className="h-aside"><span className="tag est">estimates</span> {fmtTime(routing.computedAt, false)}</span>}</h2>
      {!routing && <div className="empty">No routes yet — ask TACK TACK to update the route.</div>}
      {routing?.routes.map((r) => (
        <div key={r.id} className={`route-row ${focusId === r.id ? "active" : ""} ${r.eligible ? "" : "ineligible"}`} onMouseEnter={() => onFocus(r.id)} onClick={() => onFocus(r.id)}>
          <span className="sw" style={{ background: r.id === selectedId ? ACCENT : ROUTE_COLORS[r.id] }} />
          <div>
            <div className="nm"><span className="rid">{r.id}</span>{r.name}</div>
            <div className="sm">{fmtDur(r.metrics.durationHours)} · {r.metrics.distanceNm} nm · comfort {r.metrics.comfortIndex} · motor {r.metrics.motoringHours} h</div>
            {focusId === r.id && (
              <div className="sm" style={{ marginTop: 4, whiteSpace: "normal", color: "var(--ink-2)" }}>
                {r.description}<br />
                wind avg {r.metrics.wind.meanKn} / max {r.metrics.wind.maxKn} kn (gust {r.metrics.wind.maxGustKn}) · {r.metrics.wind.hoursAbove20} h &gt; 20 kn<br />
                waves avg {r.metrics.waves.meanM ?? "—"} / max {r.metrics.waves.maxM ?? "—"} m · upwind {r.metrics.upwindHours} h · good sailing {r.metrics.goodSailingPct}%<br />
                next 12 h: max {r.metrics.next12h.maxTwsKn} kn, waves {r.metrics.next12h.maxWaveM ?? "—"} m, comfort {r.metrics.next12h.comfortIndex}<br />
                current {r.metrics.currentGainNm >= 0 ? "+" : ""}{r.metrics.currentGainNm} nm · fuel {r.metrics.fuelLitres != null ? `${r.metrics.fuelLitres} L` : "n/a (no burn rate)"}
                {r.metrics.hoursBeyondForecast > 0 && <><br /><span style={{ color: "var(--warn)" }}>{r.metrics.hoursBeyondForecast} h beyond forecast horizon</span></>}
                {!r.eligible && <><br /><span style={{ color: "var(--warn)" }}>✕ {r.hardConstraintViolations.join("; ")}</span></>}
              </div>
            )}
          </div>
          {r.id === selectedId ? <span className="badge">Recommended</span> : !r.eligible ? <span className="badge x">Excluded</span> : null}
        </div>
      ))}
      {routing?.warnings.map((w) => <div className="notice warn" key={w}>{w}</div>)}
      {routing && (
        <div className="notice">
          Polar × {routing.correctionApplied ? "learned correction" : "baseline only"} · forecast {fmtTime(routing.weatherFetchedAt)} · departure {fmtTime(routing.departure)}
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── Decision ───────────────────────── */

function Ring({ value }: { value: number | null }) {
  const r = 22, c = 2 * Math.PI * r;
  const v = value ?? 0;
  return (
    <svg className="conf-ring" width="58" height="58" viewBox="0 0 58 58">
      <circle cx="29" cy="29" r={r} fill="none" stroke="var(--line)" strokeWidth="4" />
      {value != null && <circle cx="29" cy="29" r={r} fill="none" stroke={v < 0.6 ? "var(--warn)" : ACCENT} strokeWidth="4" strokeDasharray={`${c * v} ${c}`} transform="rotate(-90 29 29)" strokeLinecap="round" />}
      <text x="29" y="33" textAnchor="middle" style={{ font: "600 13px var(--mono)", fill: "var(--ink)" }}>{value != null ? `${Math.round(v * 100)}` : "—"}</text>
      <text x="29" y="44" textAnchor="middle" style={{ font: "500 7px var(--mono)", fill: "var(--ink-3)" }}>{value != null ? "%" : ""}</text>
    </svg>
  );
}

const LEVEL = (v: number | null, labels: string[]) => (v == null ? "—" : `${v.toFixed(1)} ${labels[Math.round(v)] ?? ""}`);

export function DecisionPanel(props: {
  decision: DecisionRecord | null;
  routing: RoutingResult | null;
  planning: boolean;
  steps: PlanStep[];
  planError: string | null;
  onPlan: (refresh?: boolean) => void;
  onAction: (routeId: string) => void;
  onFocus: (id: string) => void;
}) {
  const { decision: d, routing } = props;
  const sel = routing?.routes.find((r) => r.id === d?.selectedRouteId);
  const chosen = d?.captainAction.routeId;
  const stale = d && routing && d.routingId !== routing.id;
  return (
    <section className="panel decision">
      <h2>Recommendation {d && <span className="h-aside">{fmtTime(d.createdAt)}</span>}</h2>
      {!d && !props.planning && <div className="empty">No decision yet. Plan a route to retrieve the forecast, generate candidates and ask SubQ Snap.</div>}
      {d && (
        <>
          <div className="rec-head">
            <Ring value={d.confidence} />
            <div style={{ minWidth: 0 }}>
              <div className="rec-name">{sel ? <>{sel.id} · {sel.name}</> : "No route selected"}</div>
              {sel && <div className="rec-sub">ETA {fmtTime(sel.metrics.etaIso)} · {fmtDur(sel.metrics.durationHours)} · {sel.metrics.distanceNm} nm</div>}
              <div className="engine">decided by <b>{d.engine}</b>{d.strategyVersion && <> · strategy <b>{d.strategyVersion}</b></>}{d.similarEpisodesUsed ? ` · ${d.similarEpisodesUsed} similar past experiences` : ""}{d.weatherStale && <> · <span className="tag stale">stale forecast</span></>}</div>
              {chosen && <div className="engine" style={{ color: "var(--ok)" }}>✓ Captain {d.captainAction.action} {chosen} at {fmtTime(d.captainAction.at)}</div>}
            </div>
          </div>
          {d.askCaptain && <div className="ask"><b>Captain, your call</b>{d.askCaptain}</div>}
          {Object.keys(d.probabilities).length > 0 && (
            <div className="probs">
              {Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]).map(([id, p]) => (
                <div key={id} className={`prob ${id === d.selectedRouteId ? "sel" : ""}`} onMouseEnter={() => props.onFocus(id)} style={{ cursor: "pointer" }}>
                  <span>{id}</span><span className="track"><i style={{ width: `${p * 100}%` }} /></span><span className="pct">{(p * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          )}
          {d.assessments.length > 0 && (
            <table className="assess">
              <thead><tr><th>SubQ assessment</th><th>suitability</th><th>comfort</th><th>arrival</th></tr></thead>
              <tbody>
                {d.assessments.map((a) => (
                  <tr key={a.routeId} className={a.routeId === d.selectedRouteId ? "sel" : ""}>
                    <td>{a.routeId}</td>
                    <td title={LEVEL(a.suitability, ["unsuitable", "poor", "acceptable", "good", "excellent"])}>{a.suitability?.toFixed(1) ?? "—"}</td>
                    <td title={LEVEL(a.comfort, ["very unc.", "unc.", "tolerable", "comfortable", "very comf."])}>{a.comfort?.toFixed(1) ?? "—"}</td>
                    <td title={LEVEL(a.arrivalTradeoff, ["unacceptable", "poor", "acceptable", "good", "ideal"])}>{a.arrivalTradeoff?.toFixed(1) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.assessments.length > 0 && <div className="prov" style={{ marginTop: 3 }}>scores 0–4 · need-more-info {(100 * (d.needMoreInfo ?? 0)).toFixed(0)}% · safety concern {(100 * (d.safetyConcern ?? 0)).toFixed(0)}%</div>}
          {d.tradeoffs.length > 0 && <ul className="tradeoffs">{d.tradeoffs.map((t) => <li key={t}>{t}</li>)}</ul>}
          {d.excludedRoutes.length > 0 && <div className="notice warn">Excluded by hard constraints: {d.excludedRoutes.map((x) => `${x.id} (${x.reasons.join("; ")})`).join(" · ")}</div>}
          {d.error && <div className="notice warn">{d.error}</div>}
          <div className="notice">
            Inputs: Open-Meteo forecast retrieved {fmtTime(d.weatherFetchedAt)} · objectives {Object.entries(d.objectivesSnapshot.weights).map(([k, v]) => `${k} ${v}`).join(", ")}
            {d.objectivesSnapshot.activeTemporary.length > 0 && ` · temporary: “${d.objectivesSnapshot.activeTemporary.map((t) => t.text).join("; ")}”`}
          </div>
          {stale && <div className="notice warn">Routes were recomputed after this decision.</div>}
          {sel && !stale && (
            <div className="actions">
              <button className="btn orange" disabled={props.planning} onClick={() => props.onAction(sel.id)}>Accept {sel.id}</button>
              {routing?.routes.filter((r) => r.eligible && r.id !== sel.id).map((r) => (
                <button key={r.id} className="btn ghost sm" disabled={props.planning} onClick={() => props.onAction(r.id)} title={`Override: sail ${r.name}`}>Sail {r.id}</button>
              ))}
            </div>
          )}
        </>
      )}
      {d?.episodeId && <Feedback episodeId={d.episodeId} />}
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="btn" disabled={props.planning} onClick={() => props.onPlan()}>{props.planning ? <><span className="spin" /> Planning…</> : "Plan route"}</button>
        <button className="btn ghost" disabled={props.planning} onClick={() => props.onPlan(true)}>Refresh forecast &amp; plan</button>
      </div>
      {props.steps.length > 0 && (
        <div className="steps">{props.steps.map((s) => <div key={s.step}><span className={s.ok ? "ok" : "bad"}>{s.ok ? "✓" : "✕"}</span>{s.step}: {s.detail} {s.ms ? `(${(s.ms / 1000).toFixed(1)} s)` : ""}</div>)}</div>
      )}
      {props.planError && <div className="err">{props.planError}</div>}
    </section>
  );
}

/* ───────────────────────── Captain feedback (watch change) ───────────────────────── */

export function Feedback({ episodeId }: { episodeId: string }) {
  const [useful, setUseful] = useState<boolean | null>(null);
  const [comfort, setComfort] = useState<number | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const send = async (u: boolean | null, c: number | null) => {
    await api.feedback({ episodeId, useful: u, comfortRating: c });
    setSent(`Recorded on ${episodeId}`);
  };
  return (
    <div className="feedback">
      <span>Was the current route recommendation useful?</span>
      <button className={`btn sm ${useful === true ? "orange" : "ghost"}`} onClick={() => { setUseful(true); send(true, comfort); }}>yes</button>
      <button className={`btn sm ${useful === false ? "orange" : "ghost"}`} onClick={() => { setUseful(false); send(false, comfort); }}>no</button>
      <span style={{ marginLeft: 6 }}>comfort</span>
      <span className="stars">{[1, 2, 3, 4, 5].map((n) => <button key={n} className={comfort === n ? "on" : ""} onClick={() => { setComfort(n); send(useful, n); }}>{n}</button>)}</span>
      {sent && <span className="prov">{sent}</span>}
    </div>
  );
}
