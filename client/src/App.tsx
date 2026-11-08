import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtAge, fmtTime, type AppState, type GridPoint, type LogEntry, type PlanResult, type PlanStep, type ServiceStatus } from "./api";
import { friendlyReply, quickIntent, useConversation } from "./components/Conversation";
import { Home } from "./components/Home";
import { Logbook } from "./components/Logbook";
import { MapView } from "./components/MapView";
import { DecisionPanel, RoutesPanel } from "./components/Panels";
import { Drawer, Settings, TopBar, Wordmark, type View } from "./components/Shell";
import { StrategyLab } from "./components/StrategyLab";
import { WatchChange } from "./components/WatchChange";

const hourFloor = (ms: number) => Math.floor(ms / 3_600_000) * 3_600_000;
const viewFromHash = (): View => (location.hash === "#lab" ? "lab" : location.hash === "#logbook" ? "logbook" : "voyage");

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [grid, setGrid] = useState<GridPoint[]>([]);
  const [timeIso, setTimeIso] = useState(new Date(hourFloor(Date.now())).toISOString());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [logKey, setLogKey] = useState(0);
  const [replay, setReplay] = useState<{ voyageId: string; index: number } | null>(null);
  const [histEntries, setHistEntries] = useState<Record<string, LogEntry[]>>({});
  const [poolLegs, setPoolLegs] = useState<NonNullable<Parameters<typeof MapView>[0]["poolLegs"]>>([]);
  const [poolHighlight, setPoolHighlight] = useState<string[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<null | "watch" | "settings" | "routes">(null);
  const wasOnline = useRef<boolean | null>(null);
  const convo = useConversation();
  const [view, setView] = useState<View>(viewFromHash);
  useEffect(() => { history.replaceState(null, "", view === "voyage" ? "#" : `#${view}`); }, [view]);
  useEffect(() => { if (view !== "logbook") setReplay(null); }, [view]);

  const reload = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api.state(), api.status()]);
      setState(s);
      setStatus(st);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const logged = useCallback(() => { reload(); setLogKey((k) => k + 1); }, [reload]);

  // Connectivity watch: when the link comes back, run the pending sync queue.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const st = await api.status();
        setStatus(st);
        if (wasOnline.current === false && st.online && st.pendingSync > 0) {
          await api.sync();
          logged();
        }
        wasOnline.current = st.online;
      } catch { /* server unreachable */ }
    }, 12_000);
    return () => clearInterval(t);
  }, [logged]);

  // Forecast grid for the map at the selected hour.
  const weatherMeta = status?.weather.meta;
  useEffect(() => {
    if (!weatherMeta) return;
    const t = setTimeout(() => api.grid(timeIso).then((g) => setGrid(g.points)).catch(() => setGrid([])), 120);
    return () => clearTimeout(t);
  }, [timeIso, weatherMeta?.id]);

  const plan = useCallback(async (refresh?: boolean): Promise<PlanResult | null> => {
    setPlanning(true);
    setPlanError(null);
    setSteps([]);
    try {
      const r = await api.plan(refresh);
      setSteps(r.steps);
      setPlanError(r.error);
      setTimeIso(new Date(hourFloor(Date.now())).toISOString());
      await reload();
      setLogKey((k) => k + 1);
      return r;
    } catch (e) {
      setPlanError((e as Error).message);
      return null;
    } finally {
      setPlanning(false);
    }
  }, [reload]);

  /** "Let's update the route": position → forecast → candidates → SubQ Snap → recommendation, told in the conversation. */
  const updateRoute = useCallback(async (opts: { say?: string; refresh?: boolean } = {}) => {
    if (planning) return;
    setView("voyage");
    if (opts.say) convo.push({ from: "captain", text: opts.say });
    const id = convo.push({ from: "plan", status: "running" });
    const r = await plan(opts.refresh);
    convo.update(id, r && !r.error
      ? { status: "done", steps: r.steps, decisionId: r.decision?.id ?? null }
      : { status: "failed", steps: r?.steps, error: r?.error ?? "The route could not be updated." });
  }, [planning, plan, convo]);

  const say = useCallback(async (message: string) => {
    if (working) return;
    const quick = quickIntent(message);
    if (quick === "update_route") return updateRoute({ say: message });
    convo.push({ from: "captain", text: message });
    if (quick === "watch_change") { convo.push({ from: "tack", text: "Of course. Let’s record the watch." }); setOverlay("watch"); return; }
    if (quick === "open_logbook") { convo.push({ from: "tack", text: "Here’s the logbook." }); setView("logbook"); return; }
    setWorking("Thinking…");
    try {
      const r = await api.assistant(message);
      const f = friendlyReply(r);
      const offer = r.replan && r.ui !== "update_route" && !!(r.change || r.entry?.observations?.position);
      convo.push({ from: "tack", text: offer ? `${f.text}\n\nShall I update the route with this?` : f.text, details: f.details, via: r.via === "offline" ? "on-board parser (offline)" : r.via, offer: offer ? "replan" : null });
      logged();
      setWorking(null);
      if (r.ui === "watch_change") setOverlay("watch");
      else if (r.ui === "open_logbook") setView("logbook");
      else if (r.ui === "update_route") await updateRoute();
    } catch (e) {
      convo.push({ from: "tack", text: `I couldn’t process that: ${(e as Error).message}` });
    } finally {
      setWorking(null);
    }
  }, [working, convo, updateRoute, logged]);

  const accept = useCallback(async (routeId: string) => {
    if (!state?.decision) return;
    await api.decisionAction(state.decision.id, routeId);
    logged();
  }, [state?.decision, logged]);

  const toggleOffline = async () => {
    const st = await api.setOffline(!(status?.forcedOffline ?? false));
    setStatus(st);
    if (!st.forcedOffline && st.online && st.pendingSync > 0) await api.sync();
    wasOnline.current = st.online;
    logged();
  };

  const replayEntries = useMemo(() => (replay ? (histEntries[replay.voyageId] ?? []).filter((e) => e.kind === "observation") : []), [replay, histEntries]);

  if (!state) {
    return (
      <div className="boot">
        <Wordmark />
        <p>{loadError ? `Cannot reach the TACK TACK server: ${loadError}` : "Reading the boat, the logbook and the forecast…"}</p>
      </div>
    );
  }

  const d = state.decision;
  const routing = state.routing;
  const selectedId = d && routing && d.routingId === routing.id ? d.captainAction.routeId ?? d.selectedRouteId : null;
  const meta = status?.weather.meta;
  const timeRange: [number, number] | null = meta ? [Math.max(hourFloor(Date.now()), Date.parse(meta.firstTime)), Date.parse(meta.lastTime)] : null;

  return (
    <div className="app">
      <TopBar status={status} view={view} setView={setView} onSettings={() => setOverlay("settings")} />
      {view === "lab" ? <div className="lab-wrap"><StrategyLab /></div> : (
        <div className={`main v-${view}`}>
          <section className="pane">
            {view === "voyage" ? (
              <Home
                state={state} status={status} convo={convo} working={working} planning={planning}
                onSay={say}
                onUpdateRoute={() => updateRoute({ say: "Let’s update the route." })}
                onWatchChange={() => setOverlay("watch")}
                onLogbook={() => setView("logbook")}
                onAccept={accept}
                onFocus={setFocusId}
                onRouteDetails={() => setOverlay("routes")}
                onPriorities={() => setOverlay("settings")}
              />
            ) : (
              <Logbook
                voyages={state.voyages}
                refreshKey={logKey}
                replay={replay}
                setReplay={setReplay}
                onEntries={(id, e) => setHistEntries((h) => ({ ...h, [id]: e }))}
                onImported={logged}
                fleetDefaults={{ twsKn: state.vesselState.forecastHere?.twsKn ?? null, waveHeightM: state.vesselState.forecastHere?.waveHeightM ?? null }}
                onPoolLegs={setPoolLegs}
                onPoolHighlight={setPoolHighlight}
              />
            )}
          </section>
          <section className="chart">
            <MapView
              routing={routing}
              selectedId={selectedId}
              focusId={focusId}
              onFocus={setFocusId}
              vessel={{ lat: state.vesselState.position.lat, lon: state.vesselState.position.lon, heading: (state.vesselState.observed.headingDeg?.value as number) ?? null }}
              destination={state.voyage.destination}
              timeIso={timeIso}
              setTimeIso={setTimeIso}
              timeRange={timeRange}
              grid={replay ? [] : grid}
              weatherInfo={meta ? `Open-Meteo · retrieved ${fmtTime(meta.fetchedAt)} (${fmtAge(status?.weather.ageMinutes)} ago)${status?.weather.stale ? " · stale" : ""}` : "no forecast"}
              replay={replay ? { entries: replayEntries, index: replay.index } : null}
              poolLegs={view === "logbook" ? poolLegs : []}
              poolHighlight={poolHighlight}
              onPick={async (kind, pt) => {
                await api.voyage(kind === "start"
                  ? { start: { ...pt, label: `Start ${pt.lat.toFixed(2)}, ${pt.lon.toFixed(2)} (set on chart)` } }
                  : { destination: { ...pt, label: `Destination ${pt.lat.toFixed(2)}, ${pt.lon.toFixed(2)} (set on chart)` } });
                await reload();
              }}
            />
          </section>
        </div>
      )}

      {overlay === "watch" && (
        <WatchChange state={state} onClose={() => setOverlay(null)}
          onLogged={(e) => { logged(); convo.push({ from: "tack", text: `Watch change logged at ${fmtTime(e.timestamp)}.` }); }}
          onUpdateRoute={() => updateRoute()} />
      )}
      {overlay === "settings" && (
        <Drawer title="Settings" onClose={() => setOverlay(null)}>
          <Settings state={state} status={status} onChanged={reload} onToggleOffline={toggleOffline} />
        </Drawer>
      )}
      {overlay === "routes" && (
        <Drawer title="Routing details" wide onClose={() => setOverlay(null)}>
          <DecisionPanel
            decision={d} routing={routing} planning={planning} steps={steps} planError={planError}
            onPlan={(refresh) => { setOverlay(null); updateRoute({ refresh }); }}
            onFocus={setFocusId}
            onAction={accept}
          />
          <RoutesPanel routing={routing} selectedId={selectedId} focusId={focusId} onFocus={setFocusId} />
        </Drawer>
      )}
    </div>
  );
}
