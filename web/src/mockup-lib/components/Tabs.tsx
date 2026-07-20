import type { ReactNode } from "react";

// Tab set (schema type 'tabs'). Pure container: 'panels[i]' is the content the caller already
// rendered and Inspectable-wrapped for tab i, and only the active one is mounted. Standard theme:
// underlined tabs. Compact theme: a filled accent pill for the active tab, plain links for the
// others.
export function TabsShell({
  labels,
  active,
  onSelect,
  panels,
}: {
  labels: string[];
  active: number;
  onSelect: (i: number) => void;
  panels: ReactNode[];
}) {
  return (
    <div className="mk-tabs-block">
      <div className="mk-tabs-bar">
        {labels.map((label, i) => (
          <button key={i} type="button" className={`mk-tab-btn${i === active ? " active" : ""}`} onClick={() => onSelect(i)}>
            {label}
          </button>
        ))}
      </div>
      <div className="mk-tabs-body">{panels[active]}</div>
    </div>
  );
}
