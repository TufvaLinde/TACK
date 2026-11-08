import { useState } from "react";
import { ACCENT, fmtClock, fmtDate, fmtDur, fmtTime, type CandidateRoute, type DecisionRecord, type EffectiveObjectives, type PlanStep, type RoutingResult } from "../api";

/* What the captain sees after "Update the route": a short progress note, then at most
   three meaningful options. Every internal parameter stays one click away ("Why?",
   "All candidates"), never on the surface. */

const STEPS = ["Reading the boat’s latest position", "Retrieving the latest forecast", "Generating candidate routes", "Weighing them with SubQ Snap"];

export function PlanProgress({ status, steps, error, onDetails }: { status: "running" | "done" | "failed"; steps?: PlanStep[]; error?: string | null; onDetails?: () => void }) {
  const [open, setOpen] = useState(false);
  if (status === "running") {
    return (
      <div className="progress">
        <p>Updating the route.</p>
        <ol>{STEPS.map((s, i) => <li key={s} style={{ animationDelay: `${i * 0.9}s` }}>{s}</li>)}</ol>
      </div>
    );
  }
  const total = (steps ?? []).reduce((a, s) => a + s.ms, 0);
  return (
    <div className="progress done">
      {status === "failed" ? <p className="warn-text">{error ?? "The route could not be updated."}</p> : null}
      {steps && steps.length > 0 && (
        <button className="link" onClick={() => setOpen(!open)}>
          {status === "failed" ? "What happened" : `Route updated${total ? ` in ${(total / 1000).toFixed(1)} s` : ""}`} {open ? "↑" : "↓"}
        </button>
      )}
      {open && (
        <ul className="steplist">
          {steps!.map((s) => <li key={s.step} className={s.ok ? "" : "bad"}><b>{s.step}</b> {s.detail}</li>)}
          {onDetails && <li><button className="link" onClick={onDetails}>Open full routing details</button></li>}
        </ul>
      )}
    </div>
  );
}

const PRIORITY_WORDS: Record<string, string> = { speed: "arrival time", comfort: "crew comfort", fuel: "fuel", scenic: "scenery", sailing: "good sailing", morale: "crew morale" };

export function prioritySentence(o: EffectiveObjectives) {
  const top = Object.entries(o.weights).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => PRIORITY_WORDS[k]);
  return `Best balance of ${top[0]} and ${top[1]}`;
}

function contrast(r: CandidateRoute, base: CandidateRoute) {
  const out: string[] = [];
  const dh = (Date.parse(r.metrics.etaIso ?? "") - Date.parse(base.metrics.etaIso ?? "")) / 3_600_000;
  if (Number.isFinite(dh) && Math.abs(dh) >= 1) out.push(`${Math.round(Math.abs(dh))} h ${dh < 0 ? "sooner" : "later"}`);
  const dc = r.metrics.comfortIndex - base.metrics.comfortIndex;
  if (Math.abs(dc) >= 0.5) out.push(dc > 0 ? "more comfortable" : "less comfortable");
  if (r.metrics.wind.maxKn - base.metrics.wind.maxKn >= 3) out.push(`up to ${r.metrics.wind.maxKn} kn`);
  const dm = r.metrics.motoringHours - base.metrics.motoringHours;
  if (Math.abs(dm) >= 2) out.push(`${Math.round(Math.abs(dm))} h ${dm > 0 ? "more" : "less"} motoring`);
  return out.join(" · ") || "similar to the recommendation";
}

function conditions(r: CandidateRoute) {
  const m = r.metrics;
  return `Wind up to ${m.wind.maxKn} kn${m.waves.maxM != null ? `, waves up to ${m.waves.maxM} m` : ""}${m.motoringHours >= 1 ? `, ${Math.round(m.motoringHours)} h motoring` : ""}`;
}

interface Option { key: string; label: string; route: CandidateRoute; also: string[] }

export function options(routing: RoutingResult, recommendedId: string | null): Option[] {
  const ok = routing.routes.filter((r) => r.eligible);
  if (!ok.length) return [];
  const eta = (r: CandidateRoute) => Date.parse(r.metrics.etaIso ?? "") || Infinity;
  const fastest = [...ok].sort((a, b) => eta(a) - eta(b))[0];
  const comfy = [...ok].sort((a, b) => b.metrics.comfortIndex - a.metrics.comfortIndex || eta(a) - eta(b))[0];
  const rec = ok.find((r) => r.id === recommendedId) ?? null;
  const out: Option[] = [];
  if (rec) out.push({ key: "rec", label: "Recommended", route: rec, also: [] });
  for (const [key, label, r] of [["fast", "Fastest", fastest], ["comfort", "Most comfortable", comfy]] as const) {
    const existing = out.find((o) => o.route.id === r.id);
    if (existing) existing.also.push(label.toLowerCase());
    else out.push({ key, label, route: r, also: [] });
  }
  return out;
}

export function RouteChoices({ routing, decision, objectives, live, planning, onAccept, onFocus, onDetails }: {
  routing: RoutingResult;
  decision: DecisionRecord;
  objectives: EffectiveObjectives;
  live: boolean; // false → an older recommendation that has since been superseded
  planning: boolean;
  onAccept: (routeId: string) => void;
  onFocus: (id: string | null) => void;
  onDetails: () => void;
}) {
  const [why, setWhy] = useState(false);
  const opts = options(routing, decision.selectedRouteId);
  const rec = opts.find((o) => o.key === "rec");
  const chosen = decision.captainAction.routeId;

  if (!live) {
    const r = routing.routes.find((x) => x.id === (chosen ?? decision.selectedRouteId));
    return <p className="muted">Earlier recommendation{r ? ` — ${r.name}` : ""}, {fmtTime(decision.createdAt)}. Since superseded.</p>;
  }
  if (!opts.length) {
    return (
      <div className="choices">
        <p>None of the candidate routes satisfies your limits right now.</p>
        {decision.askCaptain && <p className="ask">{decision.askCaptain}</p>}
        <button className="link" onClick={onDetails}>See why each route was excluded</button>
      </div>
    );
  }

  return (
    <div className="choices" onMouseLeave={() => onFocus(null)}>
      {decision.askCaptain && <p className="ask"><span>Your call, Captain.</span> {decision.askCaptain}</p>}
      {opts.map((o) => {
        const r = o.route;
        const isChosen = chosen === r.id;
        return (
          <div key={o.key} className={`choice ${o.key === "rec" ? "primary" : ""} ${isChosen ? "chosen" : ""}`} onMouseEnter={() => onFocus(r.id)}>
            <div className="choice-label">
              {o.key === "rec" && <i style={{ background: ACCENT }} />}
              {o.label}{o.also.length > 0 && <span> · also {o.also.join(" & ")}</span>}
            </div>
            {o.key === "rec" ? (
              <>
                <div className="choice-title">{prioritySentence(objectives)}.</div>
                <div className="choice-eta">Arrive {fmtDate(r.metrics.etaIso)}, {fmtClock(r.metrics.etaIso)} UTC</div>
                <div className="choice-meta">{r.name} · {fmtDur(r.metrics.durationHours)} · {Math.round(r.metrics.distanceNm)} nm · {conditions(r)}</div>
              </>
            ) : (
              <>
                <div className="choice-eta">Arrive {fmtDate(r.metrics.etaIso)}, {fmtClock(r.metrics.etaIso)} UTC</div>
                <div className="choice-meta">{r.name} · {rec ? contrast(r, rec.route) : conditions(r)}</div>
              </>
            )}
            <div className="choice-actions">
              {isChosen ? (
                <span className="chosen-note">✓ {decision.captainAction.action === "accepted" ? "Accepted" : "Chosen"} {fmtClock(decision.captainAction.at)} UTC</span>
              ) : (
                <button className={`btn ${o.key === "rec" ? "" : "quiet"}`} disabled={planning} onClick={() => onAccept(r.id)}>
                  {o.key === "rec" ? "Accept route" : "Sail this instead"}
                </button>
              )}
              {o.key === "rec" && <button className="link" onClick={() => setWhy(!why)}>{why ? "Hide reasoning" : "Why this route?"}</button>}
            </div>
            {o.key === "rec" && why && <Why decision={decision} route={r} onDetails={onDetails} />}
          </div>
        );
      })}
      {(decision.engine.startsWith("local") || decision.weatherStale) && (
        <p className="fine-note">
          {decision.engine.startsWith("local") && "SubQ Snap was unreachable — this is a provisional on-board ranking. "}
          {decision.weatherStale && "Based on an older forecast."}
        </p>
      )}
    </div>
  );
}

function Why({ decision: d, route: r, onDetails }: { decision: DecisionRecord; route: CandidateRoute; onDetails: () => void }) {
  const m = r.metrics;
  return (
    <div className="why">
      {d.tradeoffs.length > 0 && <ul>{d.tradeoffs.map((t) => <li key={t}>{t}</li>)}</ul>}
      <dl>
        <dt>Decided by</dt><dd>{d.engine}{d.confidence != null ? `, ${Math.round(d.confidence * 100)}% confident` : ""}</dd>
        <dt>Comfort</dt><dd>{m.comfortIndex}/10 overall, {m.next12h.comfortIndex}/10 over the next 12 h</dd>
        <dt>Sailing</dt><dd>{m.goodSailingPct}% good sailing · {m.upwindHours} h upwind · {m.motoringHours} h motoring</dd>
        <dt>Forecast</dt><dd>Open-Meteo, retrieved {fmtTime(d.weatherFetchedAt)}{m.hoursBeyondForecast > 0 ? ` · last ${m.hoursBeyondForecast} h beyond the forecast` : ""}</dd>
        {d.excludedRoutes.length > 0 && <><dt>Ruled out</dt><dd>{d.excludedRoutes.map((x) => `${x.id} (${x.reasons.join("; ")})`).join(" · ")}</dd></>}
      </dl>
      <button className="link" onClick={onDetails}>All candidates and scores</button>
    </div>
  );
}
