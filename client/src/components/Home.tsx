import { compass, distanceNm, fmtClock, fmtDate, fmtLat, fmtLon, fmtTime, greeting, type AppState, type ServiceStatus } from "../api";
import { Composer, Thread, type Conversation, type Msg } from "./Conversation";
import { PlanProgress, prioritySentence, RouteChoices } from "./RoutePlan";

/* Home: conversation first. The captain sees, in order — where we are, how the boat is,
   anything that needs attention — then three actions and the conversation itself. */

export const shortPlace = (label: string) => label.split(/[—(,]/)[0].trim();

export function Home(p: {
  state: AppState;
  status: ServiceStatus | null;
  convo: Conversation;
  working: string | null;
  planning: boolean;
  onSay: (text: string) => void;
  onUpdateRoute: () => void;
  onWatchChange: () => void;
  onLogbook: () => void;
  onAccept: (routeId: string) => void;
  onFocus: (id: string | null) => void;
  onRouteDetails: () => void;
  onPriorities: () => void;
}) {
  const { state, status } = p;
  const d = state.decision;
  const live = (id?: string | null) => !!d && !!state.routing && id === d.id && d.routingId === state.routing.id;
  const pending = !!d && live(d.id) && d.captainAction.action === "pending" && !!d.selectedRouteId;
  const dest = shortPlace(state.voyage.destination.label);
  const sub = !state.routing ? `Shall we plan the route to ${dest}?` : pending ? "A new route recommendation is waiting for you." : "Ready to review your route?";
  const threadHasCurrent = p.convo.msgs.some((m) => m.from === "plan" && m.decisionId === d?.id);

  const renderPlan = (m: Extract<Msg, { from: "plan" }>) => {
    const isLive = live(m.decisionId);
    return (
      <>
        <PlanProgress status={m.status} steps={m.steps} error={m.error} onDetails={p.onRouteDetails} />
        {m.status === "done" && m.decisionId && d && state.routing && (isLive ? (
          <RouteChoices routing={state.routing} decision={d} objectives={state.effectiveObjectives} live planning={p.planning}
            onAccept={p.onAccept} onFocus={p.onFocus} onDetails={p.onRouteDetails} />
        ) : <p className="muted">Earlier recommendation — since superseded.</p>)}
      </>
    );
  };

  return (
    <div className="home">
      <div className="home-scroll">
        <header className="hello">
          <h1>{greeting()}, Captain.</h1>
          <p>{sub}</p>
        </header>

        <Glance state={state} onPriorities={p.onPriorities} />
        <Notices state={state} status={status} />

        <div className="primary-actions">
          <button className="action" onClick={p.onUpdateRoute} disabled={p.planning}>
            <svg viewBox="0 0 24 24"><path d="M4 18c3-1 4-5 7-6s5 2 9-6" /><circle cx="4" cy="18" r="1.6" /><circle cx="20" cy="6" r="1.6" /></svg>
            <span>{p.planning ? "Updating…" : "Update route"}</span>
          </button>
          <button className="action" onClick={p.onWatchChange}>
            <svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.5" /><path d="M12 9v4l2.5 2M10 3h4" /></svg>
            <span>Watch change</span>
          </button>
          <button className="action" onClick={p.onLogbook}>
            <svg viewBox="0 0 24 24"><path d="M6 3.5h10.5a1.5 1.5 0 0 1 1.5 1.5v15H7.5A1.5 1.5 0 0 1 6 18.5zM6 18.5A1.5 1.5 0 0 1 7.5 17H18M9.5 8h5M9.5 11h5" /></svg>
            <span>View logbook</span>
          </button>
        </div>

        {d && state.routing && live(d.id) && !threadHasCurrent && (
          <section className="current-route">
            <div className="eyebrow">Current recommendation · {fmtTime(d.createdAt)}</div>
            <RouteChoices routing={state.routing} decision={d} objectives={state.effectiveObjectives} live planning={p.planning}
              onAccept={p.onAccept} onFocus={p.onFocus} onDetails={p.onRouteDetails} />
          </section>
        )}

        <div className="conversation">
          {p.convo.msgs.length === 0 && (
            <div className="turn tack intro">
              <p>I’m keeping an eye on the forecast, the boat and the logbook. Tell me what’s happening aboard, ask me anything about the voyage, or change what matters tonight — I’ll take care of the routing.</p>
            </div>
          )}
          <Thread convo={p.convo} working={p.working} renderPlan={renderPlan} onReplan={p.onUpdateRoute} busy={p.planning} />
          {p.convo.msgs.length > 0 && <button className="link clear" onClick={p.convo.clear}>Clear conversation</button>}
        </div>
      </div>
      <Composer onSend={p.onSay} disabled={!!p.working} showSuggestions={p.convo.msgs.length === 0} />
    </div>
  );
}

function Glance({ state, onPriorities }: { state: AppState; onPriorities: () => void }) {
  const vs = state.vesselState;
  const ob = vs.observed;
  const fc = vs.forecastHere;
  const dest = state.voyage.destination;
  const nm = Math.round(distanceNm(vs.position, dest));
  const sp = ob.sailPlan?.value as any;
  const sails = sp ? [sp.main === "full" ? "full main" : sp.main === "reefed" ? `main reefed${sp.reefLevel ? ` (${sp.reefLevel})` : ""}` : sp.main === "down" ? "main down" : null,
    sp.headsail === "full" ? "full headsail" : sp.headsail === "reefed" ? "headsail reefed" : sp.headsail === "down" ? "headsail furled" : null,
    sp.engine ? "motoring" : null].filter(Boolean).join(", ") : null;
  const boat = [
    ob.headingDeg && `heading ${ob.headingDeg.value}°`,
    ob.sogKn && `${ob.sogKn.value} kn over ground`,
    sails,
  ].filter(Boolean).join(" · ");
  const latestBoat = [ob.headingDeg, ob.sogKn, ob.sailPlan].filter(Boolean).map((o) => o!.at).sort().at(-1);
  const temp = state.effectiveObjectives.activeTemporary.at(-1);

  return (
    <dl className="glance">
      <div>
        <dt>Where</dt>
        <dd>
          <span className="num">{fmtLat(vs.position.lat)}  {fmtLon(vs.position.lon)}</span>
          <small>{vs.position.at ? `fix ${fmtTime(vs.position.at)}` : "configured start position"} · {nm} nm to {shortPlace(dest.label)}</small>
        </dd>
      </div>
      <div>
        <dt>The boat</dt>
        <dd>
          {boat ? <span>{boat.replace(/^./, (c) => c.toUpperCase())}</span> : <span className="muted">No readings yet — record a watch change.</span>}
          {(ob.crewCondition || latestBoat) && <small>{ob.crewCondition ? `Crew ${ob.crewCondition.value}` : ""}{ob.crewCondition && latestBoat ? " · " : ""}{latestBoat ? `reported ${fmtTime(latestBoat)}` : ""}</small>}
        </dd>
      </div>
      <div>
        <dt>Conditions</dt>
        <dd>
          {fc && fc.twsKn != null ? (
            <span>Wind {Math.round(fc.twsKn)} kn from the {compass(fc.twdDeg)}{fc.gustKn ? `, gusting ${Math.round(fc.gustKn)}` : ""}{fc.waveHeightM != null ? ` · waves ${fc.waveHeightM} m` : ""}</span>
          ) : <span className="muted">No forecast for this position.</span>}
          {ob.twsKn ? <small>Forecast · you last reported {ob.twsKn.value} kn at {fmtClock(ob.twsKn.at)} UTC</small> : fc ? <small>Forecast</small> : null}
        </dd>
      </div>
      <div>
        <dt>Arrival</dt>
        <dd>
          {vs.eta?.etaIso ? <span>{fmtDate(vs.eta.etaIso)}, {fmtClock(vs.eta.etaIso)} UTC</span> : <span className="muted">Plan a route to estimate arrival.</span>}
          {vs.eta && <small>{vs.eta.routeName} · {vs.eta.captainAccepted ? "your chosen route" : "recommended, not yet accepted"} · estimate</small>}
        </dd>
      </div>
      <div>
        <dt>Priorities</dt>
        <dd>
          <span>{temp ? `“${temp.text}”` : `${prioritySentence(state.effectiveObjectives)}`}</span>
          <small>{temp ? `until ${fmtTime(temp.expiresAt)} · ` : ""}<button className="link" onClick={onPriorities}>adjust</button> or just tell me</small>
        </dd>
      </div>
    </dl>
  );
}

function Notices({ state, status }: { state: AppState; status: ServiceStatus | null }) {
  const out: { tone: "warn" | "info"; text: string }[] = [];
  if (status && !status.online) out.push({ tone: "info", text: `Offline — working on board.${status.pendingSync ? ` ${status.pendingSync} item${status.pendingSync > 1 ? "s" : ""} will sync when the link returns.` : ""}` });
  const w = status?.weather;
  if (w && !w.available) out.push({ tone: "warn", text: "No forecast on board. Routing needs one — connect to retrieve it." });
  else if (w?.stale) out.push({ tone: "warn", text: `The forecast is ${w.ageMinutes != null ? `${Math.round(w.ageMinutes / 60)} hours` : ""} old. Update the route to refresh it when you’re online.` });
  const r = state.routing;
  if (r && state.decision?.routingId === r.id) for (const x of r.warnings.slice(0, 2)) out.push({ tone: "warn", text: x });
  if (!out.length) return null;
  return <div className="notices">{out.map((n) => <p key={n.text} className={n.tone}>{n.text}</p>)}</div>;
}
