import { useEffect, useMemo, useState } from "react";
import { api, fmtClock, fmtDay, fmtLat, fmtLon, parseCoordInput, type AppState, type Extracted, type LogEntry, type Observations } from "../api";
import { Feedback } from "./Panels";

/* Watch change: three ways in (describe, instruments, chartplotter photo), one structured
   logbook entry out. Anything read by a model is shown for confirmation before it is
   stored, and fields that were not found stay empty — nothing is filled in by guesswork. */

type Mode = "describe" | "instruments" | "photo";
type Vals = Record<"lat" | "lon" | "heading" | "sog" | "stw" | "tws" | "twd" | "awa" | "sea" | "main" | "reef" | "headsail" | "engine" | "crew" | "remarks", string>;

const EMPTY: Vals = { lat: "", lon: "", heading: "", sog: "", stw: "", tws: "", twd: "", awa: "", sea: "", main: "", reef: "", headsail: "", engine: "", crew: "", remarks: "" };

const fromObs = (o: Observations): Vals => ({
  lat: o.position ? fmtLat(o.position.lat) : "",
  lon: o.position ? fmtLon(o.position.lon) : "",
  heading: o.headingDeg?.toString() ?? "",
  sog: o.sogKn?.toString() ?? "",
  stw: o.stwKn?.toString() ?? "",
  tws: o.twsKn?.toString() ?? "",
  twd: o.twdDeg?.toString() ?? "",
  awa: o.awaDeg?.toString() ?? "",
  sea: o.seaState ?? "",
  main: o.sailPlan?.main && o.sailPlan.main !== "unknown" ? o.sailPlan.main : "",
  reef: o.sailPlan?.reefLevel?.toString() ?? "",
  headsail: o.sailPlan?.headsail && o.sailPlan.headsail !== "unknown" ? o.sailPlan.headsail : "",
  engine: o.sailPlan?.engine == null ? "" : o.sailPlan.engine ? "on" : "off",
  crew: o.crewCondition ?? "",
  remarks: o.remarks ?? "",
});

function toObs(v: Vals): { obs: Partial<Observations>; problems: string[] } {
  const problems: string[] = [];
  const num = (s: string, label: string, min: number, max: number) => {
    if (!s.trim()) return null;
    const n = Number(s.replace(",", "."));
    if (!Number.isFinite(n) || n < min || n > max) { problems.push(`${label} looks wrong (${s})`); return null; }
    return n;
  };
  let position = null;
  if (v.lat.trim() || v.lon.trim()) {
    const lat = parseCoordInput(v.lat, "lat"), lon = parseCoordInput(v.lon, "lon");
    if (lat == null || lon == null) problems.push("Position needs both latitude and longitude, e.g. 24 12.5N and 045 30.0W");
    else position = { lat, lon };
  }
  const anySail = v.main || v.headsail || v.engine || v.reef;
  const obs: Partial<Observations> = {
    position,
    headingDeg: num(v.heading, "Heading", 0, 360),
    sogKn: num(v.sog, "SOG", 0, 40),
    stwKn: num(v.stw, "STW", 0, 40),
    twsKn: num(v.tws, "True wind speed", 0, 120),
    twdDeg: num(v.twd, "True wind direction", 0, 360),
    awaDeg: num(v.awa, "Apparent wind angle", 0, 180),
    windReference: v.tws || v.twd ? "true" : null,
    seaState: (v.sea || null) as Observations["seaState"],
    sailPlan: anySail ? {
      main: (v.main || "unknown") as any, headsail: (v.headsail || "unknown") as any,
      engine: v.engine === "" ? null : v.engine === "on", reefLevel: v.reef ? Number(v.reef) : null, raw: null,
    } : null,
    crewCondition: v.crew.trim() || null,
    remarks: v.remarks.trim() || null,
  };
  return { obs, problems };
}

/** Downscale before upload: chartplotter text stays legible, payload stays small. */
async function toDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("This image format cannot be opened here — try a PNG or JPEG.")); i.src = url; });
    const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function WatchChange({ state, onClose, onLogged, onUpdateRoute }: {
  state: AppState;
  onClose: () => void;
  onLogged: (e: LogEntry) => void;
  onUpdateRoute: () => void;
}) {
  const [mode, setMode] = useState<Mode>("describe");
  const [step, setStep] = useState<"input" | "review" | "done">("input");
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [vals, setVals] = useState<Vals>(EMPTY);
  const [read, setRead] = useState<{ fields: Set<keyof Vals>; info: Extracted["info"]; source: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<LogEntry | null>(null);
  const now = useMemo(() => new Date().toISOString(), []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [busy, onClose]);

  const extracted = (r: Extracted, source: string) => {
    const v = fromObs(r.obs);
    setVals(v);
    setRead({ fields: new Set((Object.keys(v) as (keyof Vals)[]).filter((k) => v[k] !== "")), info: r.info, source });
    setStep("review");
  };

  const readText = async () => {
    setBusy("Reading your report…"); setErr(null);
    try { extracted(await api.extract(text), "captain:watch-nl"); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const readImage = async () => {
    if (!image) return;
    setBusy("Reading the display…"); setErr(null);
    try {
      const r = await api.readImage(image);
      if (r.error) { setErr(r.info.notes.join(" ")); return; }
      extracted(r, "captain:watch-image");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const save = async (source: string) => {
    const { obs, problems } = toObs(vals);
    if (problems.length) { setErr(problems.join(". ")); return; }
    if (!Object.values(obs).some((x) => x != null)) { setErr("Nothing to log yet — add at least one reading or a remark."); return; }
    setBusy("Logging…"); setErr(null);
    try {
      const e = await api.logObservation({
        observations: obs, source,
        method: read?.info.method ?? (source === "captain:watch-form" ? "entered by captain" : undefined),
        rawText: source === "captain:watch-nl" ? text : null,
        notes: read?.info.notes,
      });
      setSaved(e); setStep("done"); onLogged(e);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const last = state.vesselState.observed;
  const hint = (k: string, unit = "") => { const o = last[k]; return o?.value != null && typeof o.value !== "object" ? `last ${o.value}${unit}` : ""; };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet" role="dialog" aria-label="Watch change">
        <header className="sheet-head">
          <div>
            <div className="eyebrow">{fmtDay(now)} · {fmtClock(now)} UTC</div>
            <h2>Watch change</h2>
          </div>
          <button className="close" aria-label="Close" onClick={onClose} disabled={!!busy}>×</button>
        </header>

        {step === "input" && (
          <>
            <p className="lede">Record how the boat is before you hand over. Say it in your own words, enter the instruments, or photograph the chartplotter.</p>
            <div className="seg" role="tablist">
              {([["describe", "Describe"], ["instruments", "Instruments"], ["photo", "Chartplotter photo"]] as const).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={mode === k} className={mode === k ? "on" : ""} onClick={() => { setMode(k); setErr(null); }}>{l}</button>
              ))}
            </div>
            {mode === "describe" && (
              <div className="pane">
                <textarea className="big" autoFocus value={text} onChange={(e) => setText(e.target.value)}
                  placeholder="Position 24 degrees north, 45 degrees west. Heading 245. We’re making about six knots. Wind is picking up and the crew had a rough night." />
                <div className="pane-foot">
                  <span className="fine-note">TACK TACK reads out the measurements. You’ll check them before anything is logged.</span>
                  <button className="btn" disabled={!text.trim() || !!busy} onClick={readText}>{busy ?? "Continue"}</button>
                </div>
              </div>
            )}
            {mode === "instruments" && (
              <div className="pane">
                <ReadingsForm vals={vals} setVals={setVals} hint={hint} />
                <div className="pane-foot">
                  <span className="fine-note">Fill in only what you have. Empty fields are recorded as not observed.</span>
                  <button className="btn" disabled={!!busy} onClick={() => save("captain:watch-form")}>{busy ?? "Log watch change"}</button>
                </div>
              </div>
            )}
            {mode === "photo" && (
              <div className="pane">
                <label className={`drop ${image ? "has" : ""}`}>
                  {image ? <img src={image} alt="Chartplotter" /> : <span>Take a photo or choose a screenshot of the chartplotter</span>}
                  <input type="file" accept="image/*" capture="environment" hidden onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setErr(null);
                    try { setImage(await toDataUrl(f)); } catch (x) { setErr((x as Error).message); }
                  }} />
                </label>
                <div className="pane-foot">
                  <span className="fine-note">An image-capable model reads the display. Values it cannot read clearly are left empty.</span>
                  <button className="btn" disabled={!image || !!busy} onClick={readImage}>{busy ?? "Read the display"}</button>
                </div>
              </div>
            )}
          </>
        )}

        {step === "review" && read && (
          <>
            <p className="lede">
              Here’s what I {read.source === "captain:watch-image" ? "read from the display" : "took from your report"}. Correct anything that’s wrong;
              empty fields weren’t {read.source === "captain:watch-image" ? "legible" : "mentioned"} and will be logged as not observed.
            </p>
            {read.source === "captain:watch-image" && image && <img className="thumb" src={image} alt="Chartplotter" />}
            {read.source === "captain:watch-nl" && <blockquote className="quote">“{text}”</blockquote>}
            <ReadingsForm vals={vals} setVals={setVals} hint={hint} found={read.fields} />
            {read.info.notes.length > 0 && <ul className="notes">{read.info.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            <div className="pane-foot">
              <button className="btn quiet" onClick={() => setStep("input")} disabled={!!busy}>Back</button>
              <button className="btn" onClick={() => save(read.source)} disabled={!!busy}>{busy ?? "Confirm and log"}</button>
            </div>
          </>
        )}

        {step === "done" && saved && (
          <div className="done">
            <p className="lede">Logged at {fmtClock(saved.timestamp)} UTC.{saved.observations?.position ? " The boat’s position is updated on the chart." : ""}</p>
            {state.decision?.episodeId && (
              <div className="handover">
                <div className="eyebrow">Before you hand over</div>
                <Feedback episodeId={state.decision.episodeId} />
              </div>
            )}
            <div className="pane-foot">
              <button className="btn quiet" onClick={onClose}>Done</button>
              <button className="btn" onClick={() => { onClose(); onUpdateRoute(); }}>Update the route with this</button>
            </div>
          </div>
        )}

        {err && <p className="warn-text">{err}</p>}
      </div>
    </div>
  );
}

function ReadingsForm({ vals, setVals, hint, found }: { vals: Vals; setVals: (v: Vals) => void; hint: (k: string, unit?: string) => string; found?: Set<keyof Vals> }) {
  const f = (k: keyof Vals, label: string, unit = "", ph = "", inputMode: "decimal" | "text" = "decimal") => (
    <label className={`f ${found ? (found.has(k) ? "found" : "missing") : ""}`}>
      <span>{label}{unit && <em>{unit}</em>}</span>
      <input inputMode={inputMode} value={vals[k]} placeholder={ph} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
    </label>
  );
  const sel = (k: keyof Vals, label: string, opts: [string, string][]) => (
    <label className={`f ${found ? (found.has(k) ? "found" : "missing") : ""}`}>
      <span>{label}</span>
      <select value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })}>
        <option value="">—</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
  const sail: [string, string][] = [["full", "Full"], ["reefed", "Reefed"], ["down", "Down"]];
  return (
    <div className="readings">
      <div className="group">
        <div className="group-title">Position</div>
        <div className="row2">
          {f("lat", "Latitude", "", "24 12.5N", "text")}
          {f("lon", "Longitude", "", "045 30.0W", "text")}
        </div>
      </div>
      <div className="group">
        <div className="group-title">Boat</div>
        <div className="row3">
          {f("heading", "Heading", "°", hint("headingDeg", "°"))}
          {f("sog", "SOG", "kn", hint("sogKn"))}
          {f("stw", "STW", "kn", hint("stwKn"))}
        </div>
      </div>
      <div className="group">
        <div className="group-title">Wind and sea</div>
        <div className="row3">
          {f("tws", "True wind speed", "kn", hint("twsKn"))}
          {f("twd", "True wind from", "°", hint("twdDeg", "°"))}
          {f("awa", "Apparent wind angle", "°")}
        </div>
        <div className="row3">
          {sel("sea", "Sea state", [["calm", "Calm"], ["slight", "Slight"], ["moderate", "Moderate"], ["rough", "Rough"], ["very rough", "Very rough"]])}
        </div>
      </div>
      <div className="group">
        <div className="group-title">Sails and engine</div>
        <div className="row4">
          {sel("main", "Main", sail)}
          {f("reef", "Reef", "", "", "decimal")}
          {sel("headsail", "Headsail", sail)}
          {sel("engine", "Engine", [["off", "Off"], ["on", "Running"]])}
        </div>
      </div>
      <div className="group">
        <div className="group-title">Aboard</div>
        {f("crew", "Crew", "", "e.g. tired after a rough night", "text")}
        <label className={`f ${found ? (found.has("remarks") ? "found" : "") : ""}`}>
          <span>Remarks</span>
          <textarea rows={2} value={vals.remarks} onChange={(e) => setVals({ ...vals, remarks: e.target.value })} />
        </label>
      </div>
    </div>
  );
}
