import { useCallback, useEffect, useState } from "react";
import { fmtTime, type Voyage } from "../api";

// Fleet memory: the shared, anonymised pool of sailing experience (MongoDB Atlas when configured).
// Search by conditions, see which vessel and voyage each experience comes from, and compare
// what the reference model predicted with what the boat actually did.

interface Result {
  source: string;
  store: string;
  voyageTag: string | null;
  provenance: string;
  vessel: { type: string; lengthFt: number | null; polarIsSample: boolean; sameVessel: boolean | "unknown" };
  when: string;
  conditions: { twsKn: number; waveHeightM: number | null; twaDeg: number | null };
  sailed: string;
  predictedSogKn: number | null;
  observedSogKn: number | null;
  performanceRatio: number | null;
  similarity: number;
}
interface Pool {
  store: string;
  experiences: number;
  sharedEpisodes: number;
  vessels: { vesselId: string; type: string; legs: number; voyages: string[] }[];
  legs: PoolLeg[];
}
export interface PoolLeg { id: string; from: { lat: number; lon: number }; to: { lat: number; lon: number }; t: string; twsKn: number; waveHeightM: number | null; observedSogKn: number }

const get = async <T,>(url: string, body?: unknown): Promise<T> => {
  const r = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d as T;
};

const STORE_LABEL: Record<string, string> = { "mongodb-atlas": "Atlas", "local-json": "on board", "local dataset (not shared)": "local, not shared" };

export function FleetMemory({ voyages, defaults, onPool, onHighlight }: {
  voyages: Voyage[];
  defaults: { twsKn: number | null; waveHeightM: number | null };
  onPool: (legs: PoolLeg[]) => void;
  onHighlight: (whens: string[]) => void;
}) {
  const [pool, setPool] = useState<Pool | null>(null);
  const [tws, setTws] = useState(String(defaults.twsKn != null ? Math.round(defaults.twsKn) : 20));
  const [hs, setHs] = useState(defaults.waveHeightM != null ? defaults.waveHeightM.toFixed(1) : "2.5");
  const [twa, setTwa] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadPool = useCallback(async () => {
    try {
      const p = await get<Pool>("/api/intelligence/pool");
      setPool(p);
      onPool(p.legs);
    } catch (e) { setErr((e as Error).message); }
  }, [onPool]);
  useEffect(() => { loadPool(); return () => { onPool([]); onHighlight([]); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async () => {
    setBusy("Searching fleet memory…"); setErr(null);
    try {
      const r = await get<{ results: Result[] }>(`/api/similar?tws=${encodeURIComponent(tws)}&hs=${encodeURIComponent(hs)}&twa=${encodeURIComponent(twa)}&k=8`);
      setResults(r.results);
      onHighlight(r.results.map((x) => x.when));
    } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  };

  const share = async (voyageId: string) => {
    setBusy("Sharing anonymised legs…"); setErr(null);
    try { await get("/api/intelligence/share-log", { voyageId }); await loadPool(); } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  };

  const historical = voyages.filter((v) => v.kind === "historical");
  const best = results?.[0]?.similarity ?? null;
  return (
    <div className="fleet">
      <div className="fleet-side">
        <h3>Fleet memory</h3>
        <div className="prov" style={{ marginBottom: 8 }}>
          Shared, anonymised sailing experience · store <b>{pool ? STORE_LABEL[pool.store] ?? pool.store : "…"}</b>
          {pool && <> · {pool.experiences} logged legs · {pool.sharedEpisodes} decision episodes</>}
        </div>
        {pool?.vessels.map((v) => (
          <div className="constraint" key={v.vesselId}>
            <span>vessel {v.vesselId.slice(0, 6)}… <small style={{ color: "var(--ink-3)" }}>{v.voyages.join(", ")}</small></span>
            <span>{v.legs} legs</span>
          </div>
        ))}
        {historical.map((v) => (
          <button key={v.id} className="btn ghost sm" style={{ marginTop: 6 }} disabled={!!busy} onClick={() => share(v.id)}
            title="Anonymised: hashed vessel id, positions rounded to 0.5°, times to the hour, no remarks">
            {pool?.experiences ? "Re-share" : "Share"} “{v.name.replace(" (historical)", "")}” to the pool
          </button>
        ))}

        <h3 style={{ marginTop: 14 }}>Search similar conditions</h3>
        <div className="form-row"><label>Wind kn</label><input value={tws} onChange={(e) => setTws(e.target.value)} /></div>
        <div className="form-row"><label>Waves m</label><input value={hs} onChange={(e) => setHs(e.target.value)} /></div>
        <div className="form-row"><label>Wind angle °</label><input value={twa} placeholder="any" onChange={(e) => setTwa(e.target.value)} /></div>
        <button className="btn orange sm" disabled={!!busy} onClick={search}>{busy ? <><span className="spin" /> {busy}</> : "Search fleet memory"}</button>
        {err && <div className="err">{err}</div>}
        <div className="prov" style={{ marginTop: 8 }}>
          Speeds are never transferred between boats. Each experience is compared with its own vessel's polar (observed ÷ predicted), and the vessel's characteristics travel with it.
        </div>
      </div>

      <div className="fleet-results">
        {!results && <div className="empty">Enter conditions and search. TACK TACK gives SubQ the closest matches as extra context for every decision.</div>}
        {results && results.length === 0 && <div className="empty">Nothing in the pool near these conditions.</div>}
        {results && results.length > 0 && (
          <>
            {best != null && best < 0.5 && <div className="notice warn" style={{ marginTop: 0, marginBottom: 6 }}>Closest match is only {Math.round(best * 100)}% similar — the pool has no experience in conditions this close. Treat these as distant references.</div>}
            <table className="lab-table">
              <thead><tr><th>match</th><th>when</th><th>from</th><th>vessel</th><th>wind · waves · angle <span className="tag fcst">fcst</span></th><th>predicted</th><th>actual <span className="tag obs">obs</span></th><th>ratio</th></tr></thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td>{Math.round(r.similarity * 100)}%</td>
                    <td>{fmtTime(r.when)}</td>
                    <td><span className="tag muted">{STORE_LABEL[r.store] ?? r.store}</span> {r.voyageTag ?? r.source}</td>
                    <td title={r.vessel.type}>{r.vessel.lengthFt ? `${r.vessel.lengthFt} ft` : "type not recorded"}{r.vessel.polarIsSample ? " · sample polar" : ""}</td>
                    <td>{r.conditions.twsKn} kn · {r.conditions.waveHeightM ?? "—"} m · {r.conditions.twaDeg ?? "—"}°</td>
                    <td>{r.predictedSogKn} kn</td>
                    <td>{r.observedSogKn} kn</td>
                    <td className={r.performanceRatio != null && Math.abs(r.performanceRatio - 1) > 0.1 ? "bad" : ""}>×{r.performanceRatio}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="prov">Predicted = TACK TACK's reference model (strategy 1.0.0 + that vessel's polar) for the leg's archived forecast. Actual = speed made good between logged positions. Ratio &gt; 1: the boat did better than its model.</div>
          </>
        )}
      </div>
    </div>
  );
}
