import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface Msg { from: "captain" | "tack"; text: string; actions?: string[]; via?: string; thinking?: boolean }

const EXAMPLE_REPORT =
  "We are at 33°09'N, 45°39'W. Heading 062 degrees. Making 6.4 knots over ground, 6.1 through water. Wind is 12 knots from 070. Full main and genoa. Crew is tired but comfortable.";

const SCENARIOS = [
  { id: "A", text: "Get us to the destination as quickly as possible." },
  { id: "B", text: "The crew is exhausted. Prioritize comfort tonight." },
  { id: "C", text: "We have time. Minimize motoring and find good sailing conditions." },
];

function load(): Msg[] {
  try { return JSON.parse(localStorage.getItem("tack-chat") ?? "[]"); } catch { return []; }
}

export function Assistant({ onReplan, busy, onLogged }: { onReplan: () => Promise<void>; busy: boolean; onLogged: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>(load);
  const [text, setText] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { localStorage.setItem("tack-chat", JSON.stringify(msgs.filter((m) => !m.thinking).slice(-60))); } catch { /* storage unavailable */ }
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs, working]);

  const send = async (message: string, opts: { reset?: boolean } = {}) => {
    if (!message.trim() || working) return;
    setText("");
    setMsgs((m) => [...m, { from: "captain", text: message }]);
    try {
      if (opts.reset) await api.objectives({ reset: true });
      setWorking("Reading your message…");
      const r = await api.assistant(message);
      setMsgs((m) => [...m, { from: "tack", text: r.reply, actions: r.actions, via: r.via === "offline" ? "offline — on-board parser" : r.via }]);
      onLogged();
      if (r.replan) {
        setWorking("Re-evaluating routes with SubQ Snap…");
        await onReplan();
      }
    } catch (e) {
      setMsgs((m) => [...m, { from: "tack", text: `Something went wrong: ${(e as Error).message}` }]);
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="assistant">
      <div className="panel"><h2>Captain’s assistant <span className="h-aside">{msgs.length > 0 && <button className="btn ghost sm" onClick={() => setMsgs([])}>clear</button>}</span></h2></div>
      <div className="chat">
        {msgs.length === 0 && (
          <div className="msg tack">
            Report the watch, change priorities or ask about the voyage. I log reports with their original wording, translate instructions into objectives, and re-plan.
            The decision is always yours.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.from}`}>
            {m.actions?.map((a) => <div className="act" key={a}>{a}</div>)}
            {m.text}
            {m.via && <div className="via">{m.via}</div>}
          </div>
        ))}
        {working && <div className="msg tack thinking"><span className="spin" /> {working}</div>}
        <div ref={end} />
      </div>
      <div className="chips">
        <button className="chip" disabled={!!working || busy} onClick={() => setText(EXAMPLE_REPORT)}>example watch report</button>
        {SCENARIOS.map((s) => (
          <button key={s.id} className="chip" disabled={!!working || busy} title={`Resets priorities, then: “${s.text}”`} onClick={() => send(s.text, { reset: true })}>
            <b>{s.id}</b>{s.text.length > 34 ? s.text.slice(0, 32) + "…" : s.text}
          </button>
        ))}
        <button className="chip" disabled={!!working || busy} onClick={() => send("Why did you recommend this route over the alternatives?")}>why this route?</button>
        <button className="chip" disabled={!!working || busy} onClick={() => send("On our Atlantic crossing, when did we see whales or dolphins?")}>ask the old log</button>
      </div>
      <div className="composer">
        <textarea value={text} placeholder="Watch report, instruction or question…" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
        <button className="btn orange" disabled={!text.trim() || !!working} onClick={() => send(text)}>Send</button>
      </div>
    </div>
  );
}
