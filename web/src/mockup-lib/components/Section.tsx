import { useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../icons";

// Generic section (schema type 'section'): white card with a title in the primary colour, a divider
// and an optional icon. Pure container: 'children' arrives already rendered and Inspectable-wrapped
// from the caller (MockupView), which recursively dispatches props.components through the registry.
// 'collapsible' — the dialog pattern, where several named blocks stack inside one card — adds a
// chevron to the title and lets the body expand/collapse; it always starts expanded. Mirrored in
// Python in server/mockup_export.py (_render_section), with the same delegated JS for the toggle.
export function Section({
  title,
  icon,
  collapsible,
  children,
}: {
  title?: string;
  icon?: string;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const showToggle = collapsible && title;
  return (
    <div className="mk-card mk-section">
      {title && (
        <div
          className={`mk-section-title${showToggle ? " mk-section-title-toggle" : ""}`}
          onClick={showToggle ? () => setOpen((v) => !v) : undefined}
        >
          {showToggle && (
            <span className={`mk-chevron${open ? " mk-chevron-open" : ""}`}>
              <Icon name="chevron-down" size={14} />
            </span>
          )}
          {icon && <Icon name={icon} size={16} />}
          <span>{title}</span>
        </div>
      )}
      {(!collapsible || open) && <div className="mk-section-body">{children}</div>}
    </div>
  );
}
