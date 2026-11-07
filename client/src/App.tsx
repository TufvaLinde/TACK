import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtAge, fmtTime, type AppState, type GridPoint, type LogEntry, type PlanStep, type ServiceStatus } from "./api";
import { Assistant } from "./components/Assistant";
import { Logbook } from "./components/Logbook";
import { MapView } from "./components/MapView";
import { DecisionPanel, ObjectivesPanel, RoutesPanel, TopBar, VesselPanel } from "./components/Panels";
import { StrategyLab } from "./components/StrategyLab";

const hourFloor = (ms: number) => Math.floor(ms / 3_600_000) * 3_600_000;

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
  const wasOnline = useRef<boolean | null>(null);
  const [view, setView] = useState<"chart" | "lab">(() => (location.hash === "#lab" ? "lab" : "chart"));
  useEffect(() => { history.replaceState(null, "", view === "lab" ? "#lab" : "#"); }, [view]);

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

  // Connectivity watch: when the link comes back, run the pending sync queue.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const st = await api.status();
        setStatus(st);
        if (wasOnline.current === false && st.online && st.pendingSync > 0) {
          await api.sync();
          await reload();
          setLogKey((k) => k + 1);
        }
        wasOnline.current = st.online;
      } catch { /* server unreachable */ }
    }, 12_000);
    return () => clearInterval(t);
  }, [reload]);

  // Forecast grid for the map at the selected hour.
  const weatherMeta = status?.weather.meta;
  useEffect(() => {
    if (!weatherMeta) return;
    const t = setTimeout(() => api.grid(timeIso).then((g) => setGrid(g.points)).catch(() => setGrid([])), 120);
    return () => clearTimeout(t);
  }, [timeIso, weatherMeta?.id]);

  const plan = useCallback(async (refresh?: boolean) => {
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
    } catch (e) {
      setPlanError((e as Error).message);
    } finally {
      setPlanning(false);
    }
  }, [reload]);

  const toggleOffline = async () => {
    const st = await api.setOffline(!(status?.forcedOffline ?? false));
    setStatus(st);
    if (!st.forcedOffline && st.online && st.pendingSync > 0) {
      await api.sync();
      await reload();
    }
    wasOnline.current = st.online;
    setLogKey((k) => k + 1);
  };

  const replayEntries = useMemo(() => (replay ? (histEntries[replay.voyageId] ?? []).filter((e) => e.kind === "observation") : []), [replay, histEntries]);
  const replayEntry = replay ? replayEntries[replay.index] ?? null : null;

  if (!state) {
    return (
      <div className="app">
        <TopBar state={null} status={status} onToggleOffline={() => {}} />
        <div style={{ color: "var(--cream)", padding: 40, fontFamily: "var(--mono)" }}>{loadError ? `Cannot reach the TACK server: ${loadError}` : <><span className="spin" /> Loading vessel, logbook and forecast…</>}</div>
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
      <TopBar state={state} status={status} onToggleOffline={toggleOffline} view={view} setView={setView} />
      {view === "lab" ? <div className="main" style={{ gridTemplateColumns: "1fr" }}><StrategyLab /></div> : (
      <div className="main">
        <aside className="col left">
          <VesselPanel state={state} replayEntry={replayEntry} />
          <ObjectivesPanel key={state.objectives.updatedAt} state={state} onChanged={reload} />
          <RoutesPanel routing={routing} selectedId={selectedId} focusId={focusId} onFocus={setFocusId} />
        </aside>
        <main className="center">
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
            weatherInfo={meta ? `Open-Meteo · retrieved ${fmtTime(meta.fetchedAt)} (${fmtAge(status?.weather.ageMinutes)} ago)${status?.weather.stale ? " · STALE" : ""}` : "no forecast"}
            replay={replay ? { entries: replayEntries, index: replay.index } : null}
            onPick={async (kind, pt) => {
              await api.voyage(kind === "start"
                ? { start: { ...pt, label: `Start ${pt.lat.toFixed(2)}, ${pt.lon.toFixed(2)} (set on chart)` } }
                : { destination: { ...pt, label: `Destination ${pt.lat.toFixed(2)}, ${pt.lon.toFixed(2)} (set on chart)` } });
              await reload();
            }}
          />
          <Logbook
            voyages={state.voyages}
            refreshKey={logKey}
            replay={replay}
            setReplay={setReplay}
            onEntries={(id, e) => setHistEntries((h) => ({ ...h, [id]: e }))}
            onImported={() => { reload(); setLogKey((k) => k + 1); }}
          />
        </main>
        <aside className="col right">
          <DecisionPanel
            decision={d}
            routing={routing}
            planning={planning}
            steps={steps}
            planError={planError}
            onPlan={plan}
            onFocus={setFocusId}
            onAction={async (routeId) => { await api.decisionAction(d!.id, routeId); await reload(); setLogKey((k) => k + 1); }}
          />
          <Assistant busy={planning} onReplan={() => plan()} onLogged={() => { reload(); setLogKey((k) => k + 1); }} />
        </aside>
      </div>)}
    </div>
  );
}
