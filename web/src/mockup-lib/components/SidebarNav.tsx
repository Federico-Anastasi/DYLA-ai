import type { ReactNode } from "react";
import { Icon } from "../icons";

// Vertical menu for navigating between sections inside a dialog (schema type 'sidebar-nav'): a
// record title, a menu such as Summary/Documents/History, an info panel, an alert list, and the
// body of the selected section on the right. This is REAL navigation, like 'tabs' — only the active
// panel is mounted — but vertical, and with two extra fixed blocks (info/alerts) that stay visible
// whichever section is selected. Pure container: 'panels[i]' arrives already rendered and
// Inspectable-wrapped from the caller (MockupView). Mirrored in Python in
// server/mockup_export.py (_render_sidebar_nav).
export function SidebarNav({
  title,
  labels,
  active,
  onSelect,
  info,
  alerts,
  panels,
}: {
  title: string;
  labels: string[];
  active: number;
  onSelect: (i: number) => void;
  info?: { title?: string; fields: { label: string; value: string }[] };
  alerts?: { title?: string; items: string[] };
  panels: ReactNode[];
}) {
  return (
    <div className="mk-sidenav-block">
      <aside className="mk-sidenav-menu">
        <div className="mk-sidenav-title">{title}</div>
        <nav className="mk-sidenav-items">
          {labels.map((label, i) => (
            <button
              key={i}
              type="button"
              className={`mk-sidenav-item${i === active ? " active" : ""}`}
              onClick={() => onSelect(i)}
            >
              {label}
            </button>
          ))}
        </nav>
        {info && (
          <div className="mk-sidenav-info">
            <div className="mk-sidenav-info-title">
              <Icon name="info" size={14} />
              <span>{info.title || "Information"}</span>
            </div>
            {info.fields.map((f, i) => (
              <div className="mk-sidenav-info-field" key={i}>
                <span className="mk-sidenav-info-label">{f.label}</span>
                <span className="mk-sidenav-info-value">{f.value}</span>
              </div>
            ))}
          </div>
        )}
        {alerts && (
          <div className="mk-sidenav-alerts">
            <div className="mk-sidenav-alerts-title">{alerts.title || "Alerts"}</div>
            {alerts.items.map((a, i) => (
              <div className="mk-sidenav-alert-item" key={i}>
                {a}
              </div>
            ))}
          </div>
        )}
      </aside>
      <div className="mk-sidenav-body">{panels[active]}</div>
    </div>
  );
}
