import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtTime, lineDiff, type EvaluationResult, type ImprovementRun, type LabState, type StrategyVersion } from "../api";

const STAGE_LABEL: Record<string, string> = {
  dataset: "Dataset", failure: "Failure", hypothesis: "Hypothesis", code: "Code change", validation: "Validation",
  version: "Version", evaluation: "Held-out evaluation", decision: "Promote / reject",
};

function StatusChip({ s }: { s: StrategyVersion["status"] | ImprovementRun["status"] }) {
  return <span className={`lab-chip st-${s}`}>{s}</span>;
}

function Diff({ before, after }: { before: string; after: string }) {
  const d = useMemo(() => lineDiff(before, after), [before, after]);
  return (
    <pre className="diff">
      {d.map((l, i) => <div key={i} className={l.t === "+" ? "add" : l.t === "-" ? "del" : ""}><span className="g">{l.t}</span>{l.line || " "}</div>)}
    </pre>
  );
}

/** Bias by sea state, production vs candidate (diverging bars around zero). */
function BiasBars({ ev }: { ev: EvaluationResult }) {
  const order = ["<1.5 m", "1.5–2.5 m", "2.5–3.5 m", "≥3.5 m", "unknown"];
  const keys = order.filter((k) => ev.production_metrics.all.bySeaState[k]);
  const max = Math.max(0.2, ...keys.flatMap((k) => [Math.abs(ev.production_metrics.all.bySeaState[k].speedBias), Math.abs(ev.candidate_metrics.all.bySeaState[k]?.speedBias ?? 0)]));
  const bar = (v: number, cls: string) => (
    <div className="bb-track">
      <div className="bb-zero" />
      <div className={`bb-bar ${cls}`} style={{ left: v >= 0 ? "50%" : `${50 - (Math.abs(v) / max) * 50}%`, width: `${(Math.abs(v) / max) * 50}%` }} />
    </div>
  );
  return (
    <div className="biasbars">
      <div className="bb-head"><span /><span>← under-predicts · speed bias (kn) · over-predicts →</span><span /></div>
      {keys.map((k) => {
        const p = ev.production_metrics.all.bySeaState[k], c = ev.candidate_metrics.all.bySeaState[k];
        return (
          <div className="bb-row" key={k}>
            <span className="bb-k">{k}<small>n={p.n}</small></span>
            <div>{bar(p.speedBias, "prod")}{c && bar(c.speedBias, "cand")}</div>
            <span className="bb-v"><span className="prod-t">{p.speedBias >= 0 ? "+" : ""}{p.speedBias.toFixed(2)}</span><br /><span className="cand-t">{c ? `${c.speedBias >= 0 ? "+" : ""}${c.speedBias.toFixed(2)}` : "—"}</span></span>
          </div>
        );
      })}
      <div className="bb-legend"><span className="sw prod" /> production {ev.production} <span className="sw cand" /> candidate {ev.candidate}</div>
    </div>
  );
}

function MetricsTable({ ev }: { ev: EvaluationResult }) {
  const groups = Object.keys(ev.production_metrics);
  const pct = (c: number | null, p: number | null) => (c == null || p == null || !p ? "" : `${(((c - p) / p) * 100).toFixed(0)}%`);
  return (
    <table className="lab-table">
      <thead><tr><th>held-out</th><th>n</th><th>speed MAE kn</th><th>bias kn</th><th>ETA MAE min</th></tr></thead>
      <tbody>
        {groups.map((g) => {
          const p = ev.production_metrics[g], c = ev.candidate_metrics[g];
          return (
            <tr key={g}>
              <td>{g === "all" ? <b>all</b> : g === "historical-log" ? <>real log <span className="tag obs">real</span></> : <>synthetic <span className="tag est">synthetic</span></>}</td>
              <td>{p.n}</td>
              <td>{p.speedMAE} → <b>{c.speedMAE}</b> <small>{pct(c.speedMAE, p.speedMAE)}</small></td>
              <td>{p.speedBias} → {c.speedBias}</td>
              <td>{p.etaMAEmin} → <b>{c.etaMAEmin}</b> <small>{pct(c.etaMAEmin, p.etaMAEmin)}</small></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function StrategyLab() {
  const [lab, setLab] = useState<LabState | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<ImprovementRun | null>(null);
  const [source, setSource] = useState<{ v: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const l = await api.lab();
    setLab(l);
    setRunId((cur) => cur ?? l.runs[0]?.id ?? null);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const tick = async () => {
      const r = await api.labRunGet(runId);
      if (stop) return;
      setRun(r);
      if (r.status === "running") setTimeout(tick, 1500);
      else load();
    };
    tick();
    return () => { stop = true; };
  }, [runId, load]);

  if (!lab) return <div className="lab"><div className="panel empty">Loading Strategy Lab…</div></div>;
  const stage = (n: string) => run?.stages.find((s) => s.name === n);
  const failure = stage("failure")?.detail as any;
  const code = stage("code")?.detail as { before: string; after: string; targetFunctions: string[] } | null;
  const ev = stage("evaluation")?.detail as EvaluationResult | null;
  const hyp = stage("hypothesis")?.detail as { title: string; via: string; attempts: { attempt: number; problems: string[]; devMae: number | null }[] } | null;
  const prod = lab.strategies.find((s) => s.status === "production");
  const cand = run?.candidateVersion ? lab.strategies.find((s) => s.version === run.candidateVersion) : null;
  const running = run?.status === "running";

  return (
    <div className="lab">
      <div className="lab-head">
        <div>
          <h1>Strategy Lab</h1>
          <div className="lab-sub">FAILURE → HYPOTHESIS → CODE → VERSION → HELD-OUT EVALUATION → PROMOTION / ROLLBACK</div>
        </div>
        <div className="lab-prod">production <b>{lab.production}</b>{prod && <span> · {prod.title}</span>}</div>
        <button className="btn orange" disabled={running} onClick={async () => { setErr(null); try { const r = await api.labRun(); setRunId(r.id); setRun(r); } catch (e) { setErr((e as Error).message); } }}>
          {running ? <><span className="spin" /> Cycle running…</> : "Run improvement cycle"}
        </button>
        <button className="btn ghost" disabled={running} title="Submit a deliberately flawed, hand-written candidate to prove the evaluator rejects it" onClick={async () => { setErr(null); try { const r = await api.labRun("self-test"); setRunId(r.id); setRun(r); } catch (e) { setErr((e as Error).message); } }}>
          Evaluator self-test
        </button>
        {lab.production !== "1.0.0" && (
          <button className="btn ghost" disabled={running} title="Restore the baseline to replay the demonstration from the start" onClick={async () => { await api.labRollback("1.0.0"); setRunId(null); setRun(null); load(); }}>
            Reset to baseline
          </button>
        )}
      </div>
      {err && <div className="notice warn" style={{ margin: "8px 16px" }}>{err}</div>}

      <div className="lab-grid">
        {/* ── versions & data ── */}
        <aside className="lab-col">
          <section className="panel">
            <h2>Version history</h2>
            {[...lab.strategies].reverse().map((s) => (
              <div key={s.version} className={`ver ${s.status}`}>
                <div className="ver-top"><b>{s.version}</b> <StatusChip s={s.status} /> <span className="ver-t">{s.title}</span></div>
                <div className="prov">{s.author} · {fmtTime(s.createdAt)}{s.parent ? ` · from ${s.parent}` : ""} · sha {s.sourceHash}</div>
                {s.changeSummary && <div className="ver-c">{s.changeSummary}</div>}
                <div className="actions" style={{ marginTop: 4 }}>
                  <button className="btn ghost sm" onClick={async () => { const r = await api.labSource(s.version); setSource({ v: s.version, text: r.source }); }}>source</button>
                  {s.runId && <button className="btn ghost sm" onClick={() => setRunId(s.runId)}>run</button>}
                  {s.status === "retired" && s.promotedAt && <button className="btn ghost sm" onClick={async () => { await api.labRollback(s.version); load(); }}>roll back to this</button>}
                </div>
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>Benchmark data</h2>
            {lab.dataset ? (
              <>
                <div className="constraint"><span>Real log legs <span className="tag obs">real</span></span><span>{lab.dataset.real.dev} dev · {lab.dataset.real.heldout} held-out</span></div>
                <div className="constraint"><span>Synthetic <span className="tag est">synthetic</span></span><span>{lab.dataset.synthetic.dev} dev · {lab.dataset.synthetic.heldout} held-out</span></div>
                <div className="prov" style={{ marginTop: 6 }}>
                  Real legs: consecutive sailing entries of the imported log (no engine), speed made good between logged positions, paired with Open-Meteo's archived forecast. Skipped: {Object.entries(lab.dataset.skipped).map(([k, v]) => `${k} (${v})`).join(" · ")}.<br />
                  Synthetic: generated from a hidden vessel model; used to demonstrate the mechanism, never as decision context.<br />
                  Split is fixed (real legs by day). The agent only sees dev.
                </div>
              </>
            ) : <div className="empty">Built on the first cycle.</div>}
          </section>
          <section className="panel">
            <h2>Promotion gates</h2>
            <div className="prov">speed MAE ≥ {lab.gates.minSpeedMaeImprovement * 100}% better · ETA MAE ≤ +{lab.gates.maxEtaMaeRegression * 100}% · no sea-state bucket &gt; +{lab.gates.maxBucketRegression * 100}% · real-log ≤ +{lab.gates.maxRealDataRegression * 100}% · no new hard-constraint violations</div>
            <div className="prov" style={{ marginTop: 6 }}>Hard limits (wind, waves, deadline, restricted areas, land) are enforced by the router outside strategy modules; module outputs are clamped.</div>
          </section>
          <section className="panel">
            <h2>Decisions by version</h2>
            {Object.entries(lab.episodesByVersion).map(([v, b]) => (
              <div className="constraint" key={v}><span>{v}</span><span>{b.episodes} episodes · {b.withObservations} with obs · {b.feedback ? `${b.useful}/${b.feedback} useful` : "no feedback"}</span></div>
            ))}
            <div className="prov">store: {lab.store} · shared pool: {lab.sharedEpisodes} anonymised episodes</div>
          </section>
        </aside>

        {/* ── the cycle ── */}
        <main className="lab-main">
          {!run && <div className="panel empty">No improvement cycle yet. Press “Run improvement cycle”.</div>}
          {run && (
            <>
              <div className="pipeline">
                {run.stages.map((s) => (
                  <div key={s.name} className={`pipe ${s.status}`} title={s.summary ?? ""}>
                    <span className="dot" />{STAGE_LABEL[s.name]}
                  </div>
                ))}
              </div>
              {run.mode === "self-test" && <div className="notice warn" style={{ marginBottom: 8 }}>EVALUATOR SELF-TEST — the candidate below is a deliberately flawed, hand-written change, not an agent proposal. It exists to show the held-out gates reject bad changes.</div>}
              {run.status === "no-change" && <div className="notice" style={{ marginBottom: 8 }}>No significant recurring error remains on the development set — the agent proposes nothing and production is unchanged.</div>}
              <div className="run-meta">run {run.id} · {fmtTime(run.createdAt)} · base {run.baseVersion}{run.candidateVersion ? ` → candidate ${run.candidateVersion}` : ""} · <StatusChip s={run.status} /> · agent model {run.model}</div>

              <section className="lab-card">
                <h3><span className="n">1</span> Identified failure <span className="tag muted">dev split only</span></h3>
                <p>{stage("failure")?.summary ?? <span className="empty">pending</span>}</p>
                {failure?.tables?.["sea state"] && (
                  <table className="lab-table small">
                    <thead><tr><th>sea state (dev)</th><th>n</th><th>bias kn</th><th>MAE kn</th><th>t</th></tr></thead>
                    <tbody>{failure.tables["sea state"].map((r: any) => <tr key={r.bucket}><td>{r.bucket}</td><td>{r.n}</td><td className={r.bias > 0.2 ? "bad" : ""}>{r.bias >= 0 ? "+" : ""}{r.bias}</td><td>{r.mae}</td><td>{r.t}</td></tr>)}</tbody>
                  </table>
                )}
              </section>

              <section className="lab-card">
                <h3><span className="n">2</span> Hypothesis {hyp && <span className="tag est">{hyp.via}</span>}</h3>
                {hyp?.title && <div className="hyp-title">{hyp.title}</div>}
                <p className="hyp">{stage("hypothesis")?.summary ?? <span className="empty">pending</span>}</p>
                {hyp?.attempts && <div className="prov">attempts: {hyp.attempts.map((a) => `#${a.attempt} ${a.problems.length ? `invalid (${a.problems[0]})` : `dev MAE ${a.devMae}`}`).join(" · ")}</div>}
              </section>

              <section className="lab-card">
                <h3><span className="n">3</span> Code modification {code && <span className="prov">functions: {code.targetFunctions.join(", ")}</span>}</h3>
                <p>{stage("code")?.summary ?? <span className="empty">pending</span>}</p>
                {code && <Diff before={code.before} after={code.after} />}
                {stage("validation")?.summary && <div className="notice">{stage("validation")!.summary}</div>}
              </section>

              <section className="lab-card">
                <h3><span className="n">4</span> Versioning</h3>
                <p>{stage("version")?.summary ?? <span className="empty">pending</span>}</p>
              </section>
            </>
          )}
        </main>

        {/* ── evaluation ── */}
        <aside className="lab-col right">
          <section className="panel">
            <h2>Held-out evaluation {ev && <span className="h-aside">{fmtTime(ev.createdAt)}</span>}</h2>
            {!ev && <div className="empty">{running ? "Waiting for the candidate…" : "No evaluation in this run."}</div>}
            {ev && (
              <>
                <div className={`verdict ${ev.decision}`}>{ev.decision === "promote" ? `PROMOTED ${ev.candidate}` : `REJECTED ${ev.candidate} — production stays ${ev.production}`}</div>
                <MetricsTable ev={ev} />
                <BiasBars ev={ev} />
                <div className="gates">
                  {ev.gates.map((g) => <div key={g.name} className={g.passed ? "ok" : "bad"}><span>{g.passed ? "✓" : "✕"}</span><div><b>{g.name}</b><br /><small>{g.detail}</small></div></div>)}
                </div>
                <h2 style={{ marginTop: 14 }}>Counterfactual passages <span className="tag est">simulated</span></h2>
                <table className="lab-table small">
                  <thead><tr><th>forecast</th><th>fastest h</th><th>pick</th><th>violations</th></tr></thead>
                  <tbody>{ev.counterfactual.scenarios.map((c) => <tr key={c.name}><td>{c.name}</td><td>{c.production.fastestH} → {c.candidate.fastestH}</td><td>{c.production.selected} → {c.candidate.selected}</td><td>{c.production.violations} → {c.candidate.violations}</td></tr>)}</tbody>
                </table>
                <div className="prov">{ev.counterfactual.note}</div>
                <div className="prov" style={{ marginTop: 8 }}>
                  Fuel: {ev.fuel.note}<br />
                  Comfort: {ev.comfort.note}{ev.comfort.n ? ` (n=${ev.comfort.n}, production MAE ${ev.comfort.productionMAE})` : ""}<br />
                  Preference satisfaction: {ev.preference.note}{ev.preference.usefulRate != null ? ` ${(ev.preference.usefulRate * 100).toFixed(0)}% (n=${ev.preference.n})` : ""}
                </div>
              </>
            )}
            {run && stage("decision")?.summary && <div className="notice" style={{ marginTop: 10 }}>{stage("decision")!.summary}</div>}
            {run?.status === "failed" && <div className="notice warn">{run.stages.find((s) => s.status === "failed")?.summary}</div>}
          </section>
          <section className="panel">
            <h2>Runs</h2>
            {lab.runs.map((r) => (
              <div key={r.id} className={`route-row ${r.id === runId ? "active" : ""}`} onClick={() => setRunId(r.id)} style={{ gridTemplateColumns: "1fr auto" }}>
                <div><div className="nm">{r.baseVersion}{r.candidateVersion ? ` → ${r.candidateVersion}` : ""}</div><div className="sm">{fmtTime(r.createdAt)}</div></div>
                <StatusChip s={r.status} />
              </div>
            ))}
          </section>
        </aside>
      </div>

      {source && (
        <div className="modal" onClick={() => setSource(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <div className="actions" style={{ justifyContent: "space-between", marginBottom: 8 }}><h3>Strategy {source.v}</h3><button className="btn ghost sm" onClick={() => setSource(null)}>close</button></div>
            <pre className="diff">{source.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
