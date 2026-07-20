// What the engine is doing, in the sidebar under the model.
//
// The line is always there when the engine is running, and it opens into the numbers.
// It lives here rather than in a dashboard on its own port because there is one app: the
// speed of the model is part of using it, not a separate tool you go and look at.
//
// Polling only happens while the panel is open, or while a turn is in flight — asking an
// idle engine every two seconds forever costs something and tells you nothing new.
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../api/client";
import type { EngineMetrics } from "../types";
import { Icon } from "./icons";

const IDLE_POLL = 8000;
const BUSY_POLL = 1500;

/** A speed, with a ~ when it is the last known one rather than a fresh measurement.
 *  llama-server only updates its counters when a request finishes, so while the engine
 *  is generating there is nothing new to measure and this is the speed of the previous
 *  turn — close enough to be useful, not so exact that we should pretend it is live. */
function rate(value: number | null | undefined, live: boolean | undefined): string {
  if (value === null || value === undefined) return "—";
  return live ? String(value) : `~${value}`;
}

/** 1234 -> "1.2k". The panel is a sidebar column: six digits do not fit. */
function short(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(Math.round(n));
  return `${Math.round(n / 100) / 10}k`;
}

export default function EnginePanel({ open, onToggle, onOpenChat }: {
  open: boolean;
  onToggle: () => void;
  onOpenChat: (project: string, chatId: string) => void;
}) {
  const [m, setM] = useState<EngineMetrics | null>(null);

  const read = useCallback(async () => {
    try {
      setM(await apiClient.engineMetrics());
    } catch {
      setM({ running: false });  // the backend is unreachable: same thing to the reader
    }
  }, []);

  useEffect(() => {
    read();
    // Polling always runs, only the pace changes: fast while a turn is in flight, slow
    // otherwise. It used to stop entirely when the panel was closed and the engine idle
    // — which sounds thrifty until you notice that the only thing that can report a turn
    // starting IS a poll. With the panel closed the dot could never turn to "working",
    // so the one state worth watching from across the room was the one it never showed.
    const t = setInterval(read, m?.busy ? BUSY_POLL : IDLE_POLL);
    return () => clearInterval(t);
  }, [read, m?.busy]);

  if (!m?.running) return null;

  const used = m.context_used ?? 0;
  const size = m.context_size ?? 0;
  const share = size ? used / size : 0;

  return (
    <div className="engine-panel">
      <button type="button" className="engine-head" onClick={onToggle}
              title={open ? "hide engine details" : "show engine details"}>
        <span className={`engine-dot${m.busy ? " busy" : ""}`} />
        <span className="engine-head-label">{m.busy ? "working" : "engine ready"}</span>
        {m.busy && m.generation_tps ? (
          <span className="engine-head-rate">{rate(m.generation_tps, m.rates_live)} tok/s</span>
        ) : null}
        <Icon name="chevron-down" size={11} />
      </button>

      {open && (
        <div className="engine-body">
          {/* Generation and prefill are separated on purpose: they run an order of
              magnitude apart, and which one you are waiting on decides what to do
              about it. */}
          <div className="engine-row">
            <span>generating</span>
            <strong>{rate(m.generation_tps, m.rates_live)} <span className="engine-unit">tok/s</span></strong>
          </div>
          <div className="engine-row">
            <span>reading</span>
            <strong>{rate(m.prefill_tps, m.rates_live)} <span className="engine-unit">tok/s</span></strong>
          </div>

          {size > 0 && (
            <div className="engine-context">
              <div className="engine-row">
                <span>context</span>
                <strong>{short(used)} / {short(size)}</strong>
              </div>
              <div className="engine-bar">
                <div className={`engine-bar-fill${share >= 0.8 ? " full" : ""}`}
                     style={{ width: `${Math.min(100, share * 100)}%` }} />
              </div>
              {/* Whose context this is. The engine holds one conversation at a time, so
                  without a name these numbers read as belonging to whatever project the
                  user happens to have open — and it is usually a different one. The link
                  is not just navigation: this chat is the one whose prompt is already
                  cached, so picking up here costs seconds and starting elsewhere does
                  not. */}
              {m.holding && (
                <div className="engine-note">
                  holding{" "}
                  <button type="button" className="engine-link"
                          onClick={() => onOpenChat(m.holding!.project, m.holding!.chat_id)}
                          title="continue this conversation — its context is already loaded">
                    {m.holding.project} · {m.holding.title}
                  </button>
                </div>
              )}
              {m.context_peak ? (
                <div className="engine-note">most held so far: {short(m.context_peak)}</div>
              ) : null}
            </div>
          )}

          <div className="engine-note">
            {short(m.tokens_generated)} written · {short(m.tokens_prefilled)} read, this session
          </div>
        </div>
      )}
    </div>
  );
}
