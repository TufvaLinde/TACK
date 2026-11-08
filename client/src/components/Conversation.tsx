import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantResult, PlanStep } from "../api";

/* ───────────────────────── Conversation state ─────────────────────────
   Messages are kept per browser so the thread survives a reload. Route
   recommendations are not copied into the thread: a "plan" message only
   remembers which decision it produced and renders it live from app state. */

export type Msg =
  | { id: string; from: "captain"; text: string }
  | { id: string; from: "tack"; text: string; details?: string[]; via?: string; offer?: "replan" | null; offerDone?: boolean }
  | { id: string; from: "plan"; status: "running" | "done" | "failed"; steps?: PlanStep[]; error?: string | null; decisionId?: string | null };

type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, "id"> & { id?: string } : never) : never;

const KEY = "tacktack-chat";
const uid = () => Math.random().toString(36).slice(2, 10);

function load(): Msg[] {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem("tack-chat") ?? "[]";
    return (JSON.parse(raw) as any[]).map((m) => ({ id: m.id ?? uid(), ...m, ...(m.from === "plan" && m.status === "running" ? { status: "failed", error: "Interrupted" } : {}) }));
  } catch {
    return [];
  }
}

export function useConversation() {
  const [msgs, setMsgs] = useState<Msg[]>(load);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(msgs.slice(-60))); } catch { /* storage unavailable */ }
  }, [msgs]);
  const push = useCallback((m: NewMsg) => {
    const id = m.id ?? uid();
    setMsgs((x) => [...x, { ...m, id } as Msg]);
    return id;
  }, []);
  const update = useCallback((id: string, patch: Partial<Msg>) => setMsgs((x) => x.map((m) => (m.id === id ? ({ ...m, ...patch } as Msg) : m))), []);
  const clear = useCallback(() => setMsgs([]), []);
  return { msgs, push, update, clear };
}
export type Conversation = ReturnType<typeof useConversation>;

/** Obvious workflow requests are handled immediately, without a model round-trip. */
export function quickIntent(text: string): "watch_change" | "update_route" | "open_logbook" | null {
  const t = text.toLowerCase().trim().replace(/[.!]+$/, "");
  if (t.length > 70) return null;
  if (/^(ok(ay)?,? )?(let'?s |can we |time (for|to) |start (a |the )?|do (a |the )?|begin (a |the )?)*(do (a |the )?)?(watch ?change|change (of )?(the )?watch|changing (the )?watch)$/.test(t)) return "watch_change";
  if (/^(ok(ay)?,? )?(let'?s |please |can you |could you )?(update|re-?plan|refresh|recalculate|plan)( the| our| a new)? route$|^re-?route( us)?$/.test(t)) return "update_route";
  if (/^(open|show|view)( me)?( the)? (log ?book|journal)$/.test(t)) return "open_logbook";
  return null;
}

/** Turns the assistant's structured result into a short, human reply. Technical detail moves into "details". */
export function friendlyReply(r: AssistantResult): { text: string; details: string[] } {
  const parts: string[] = [];
  if (r.entry?.observations) {
    const o = r.entry.observations;
    const got = [
      o.position && "position",
      o.headingDeg != null && `heading ${o.headingDeg}°`,
      o.sogKn != null && `${o.sogKn} kn over ground`,
      o.twsKn != null && `wind ${o.twsKn} kn`,
      o.crewCondition && `crew ${o.crewCondition}`,
    ].filter(Boolean);
    parts.push(got.length ? `Logged in the logbook — ${got.join(", ")}.` : "Noted in the logbook.");
  }
  if (r.change) {
    const c = r.change;
    let s = `Understood — ${c.summary.replace(/\.$/, "").replace(/^./, (x) => x.toLowerCase())}`;
    if (c.temporary?.durationHours) s += ` for the next ${Math.round(c.temporary.durationHours)} hours`;
    parts.push(`${s}.`);
    if (c.clarificationNeeded) parts.push(c.clarificationNeeded);
  }
  if (r.reply) parts.push(r.reply);
  return { text: parts.join("\n\n") || "Noted.", details: r.actions };
}

/* ───────────────────────── Thread view ───────────────────────── */

export function Thread({ convo, working, renderPlan, onReplan, busy }: {
  convo: Conversation;
  working: string | null;
  renderPlan: (m: Extract<Msg, { from: "plan" }>) => React.ReactNode;
  onReplan: () => void;
  busy: boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [convo.msgs.length, working]);
  return (
    <div className="thread">
      {convo.msgs.map((m) => {
        if (m.from === "plan") return <div key={m.id} className="turn tack">{renderPlan(m)}</div>;
        if (m.from === "captain") return <div key={m.id} className="turn captain"><p>{m.text}</p></div>;
        return (
          <div key={m.id} className="turn tack">
            <p>{m.text}</p>
            {m.offer === "replan" && !m.offerDone && (
              <div className="offer">
                <button className="btn" disabled={busy} onClick={() => { convo.update(m.id, { offerDone: true } as Partial<Msg>); onReplan(); }}>Update the route</button>
                <button className="btn quiet" onClick={() => convo.update(m.id, { offerDone: true } as Partial<Msg>)}>Not now</button>
              </div>
            )}
            {(m.details?.length || m.via) ? (
              <details className="fine">
                <summary>Details</summary>
                {m.details?.map((d) => <div key={d}>{d}</div>)}
                {m.via && <div>via {m.via}</div>}
              </details>
            ) : null}
          </div>
        );
      })}
      {working && <div className="turn tack working"><span className="pulse" /> {working}</div>}
      <div ref={end} />
    </div>
  );
}

const SUGGESTIONS = [
  "We’re making good progress, but the crew is exhausted. Let’s prioritise comfort tonight.",
  "Get us there as quickly as possible.",
  "Minimise motoring.",
  "Why did you recommend this route?",
  "On our Atlantic crossing, when did we see whales or dolphins?",
];

export function Composer({ onSend, disabled, showSuggestions }: { onSend: (t: string) => void; disabled: boolean; showSuggestions: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);
  const send = () => { if (!text.trim() || disabled) return; onSend(text.trim()); setText(""); };
  return (
    <div className="composer">
      {showSuggestions && (
        <div className="suggest">
          {SUGGESTIONS.map((s) => <button key={s} disabled={disabled} onClick={() => onSend(s)}>{s}</button>)}
        </div>
      )}
      <div className="field">
        <textarea ref={ref} rows={1} value={text} placeholder="Tell TACK TACK what’s happening aboard, or ask anything…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="send" aria-label="Send" disabled={!text.trim() || disabled} onClick={send}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </div>
    </div>
  );
}
