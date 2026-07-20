import { Icon } from "../icons";

// Vertical status progression (schema type 'state-progress'), typically in the side column of a
// record view. states = the labels, plus an optional date on the completed ones; current = the
// active state (1-based). Same semantics as WizardSteps, but the layout is always vertical and a
// timestamp sits under each label.
export function StateProgress({ title, states, current }: { title?: string; states: { label: string; date?: string }[]; current: number }) {
  return (
    <div className="mk-state-progress">
      <div className="mk-state-progress-title">{title || "Status"}</div>
      {states.map((s, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "active" : "todo";
        return (
          <div className={`mk-progress-step mk-progress-step-${state}`} key={i}>
            <span className="mk-progress-circle">{state === "done" ? <Icon name="check" size={14} /> : n}</span>
            <span className="mk-progress-text">
              <span className="mk-progress-label">{s.label}</span>
              {s.date && <span className="mk-progress-timestamp">{s.date}</span>}
            </span>
            {i < states.length - 1 && <span className="mk-progress-connector" />}
          </div>
        );
      })}
    </div>
  );
}
