import { useEffect } from "react";
import { fmtAge, fmtTime, type AppState, type ServiceStatus } from "../api";
import { ObjectivesPanel, VesselPanel } from "./Panels";

export type View = "voyage" | "logbook" | "lab";

export function Wordmark() {
  return (
    <span className="wordmark" aria-label="TACK TACK">
      <svg viewBox="0 0 28 20" aria-hidden="true"><path d="M2 16 L9 4 L16 16 L23 4" /><circle cx="23" cy="4" r="2" /></svg>
      <b>TACK</b><b>TACK</b>
    </span>
  );
}

export function TopBar({ status, view, setView, onSettings }: { status: ServiceStatus | null; view: View; setView: (v: View) => void; onSettings: () => void }) {
  const offline = status ? !status.online : false;
  const w = status?.weather;
  return (
    <header className="topbar">
      <button className="brand" onClick={() => setView("voyage")}><Wordmark /></button>
      <nav className="nav">
        <button className={view === "voyage" ? "on" : ""} onClick={() => setView("voyage")}>Voyage</button>
        <button className={view === "logbook" ? "on" : ""} onClick={() => setView("logbook")}>Logbook</button>
        <button className={view === "lab" ? "on" : ""} onClick={() => setView("lab")} title="How TACK TACK improves its own routing strategy">Lab</button>
      </nav>
      <div className="spacer" />
      {status && (
        <button className={`status ${offline ? "off" : ""} ${w?.stale || (w && !w.available) ? "warn" : ""}`} onClick={onSettings} title="Connections and settings">
          <i />
          {offline ? (status.forcedOffline ? "Offline (simulated)" : "Offline") : "Online"}
          {w?.available && <span className="age">forecast {fmtAge(w.ageMinutes)} old</span>}
        </button>
      )}
      <button className="icon" aria-label="Settings" onClick={onSettings}>
        <svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
      </button>
    </header>
  );
}

export function Drawer({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={`drawer ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button className="close" aria-label="Close" onClick={onClose}>×</button></header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Secondary settings: advanced priorities and limits, all readings, connections. */
export function Settings({ state, status, onChanged, onToggleOffline }: { state: AppState; status: ServiceStatus | null; onChanged: () => void; onToggleOffline: () => void }) {
  const w = status?.weather;
  return (
    <div className="settings">
      <section>
        <h3>Priorities</h3>
        <p className="fine-note">The easiest way to change priorities is to say so — “prioritise comfort tonight”, “minimise motoring”, “we must arrive by Friday noon”. TACK TACK turns that into the weights and limits below. Wind, wave, deadline and area limits are hard constraints the router never trades away.</p>
        <ObjectivesPanel key={state.objectives.updatedAt} state={state} onChanged={onChanged} />
      </section>
      <section>
        <h3>Latest readings</h3>
        <VesselPanel state={state} replayEntry={null} />
      </section>
      <section>
        <h3>Connections</h3>
        <dl className="kv-list">
          <dt>Link</dt><dd>{status ? (status.online ? "Online" : status.forcedOffline ? "Offline (simulated)" : "Offline") : "—"}{status?.pendingSync ? ` · ${status.pendingSync} to sync` : ""}</dd>
          <dt>Language model</dt><dd>{status ? `${status.model.model} · ${status.model.provider}${!status.model.configured ? " · not configured" : ""}` : "—"}{status?.model.lastError && <small>{status.model.lastError}</small>}</dd>
          <dt>Route decisions</dt><dd>{status ? `${status.decision.model} · ${status.decision.provider}${!status.decision.configured ? " · not configured" : ""}` : "—"}{status?.decision.lastError && <small>{status.decision.lastError}</small>}</dd>
          <dt>Forecast</dt><dd>{w?.available ? `Open-Meteo · retrieved ${fmtTime(w.meta!.fetchedAt)} (${fmtAge(w.ageMinutes)} ago)${w.stale ? " · stale" : ""}` : "none on board"}{w?.lastError && <small>{w.lastError}</small>}</dd>
          <dt>Polar</dt><dd>{state.polar.name}{state.polar.isSample ? " · sample polar" : ""}</dd>
        </dl>
        <button className="btn quiet" onClick={onToggleOffline}>{status?.forcedOffline ? "End simulated offline mode" : "Simulate losing connectivity"}</button>
      </section>
      <p className="fine-note">TACK TACK is a prototype and not certified navigation software. The captain always decides.</p>
    </div>
  );
}
