import { Icon } from "../icons";

// Row of action buttons (schema type 'actions'). style: primary (filled) | secondary (grey outline)
// | danger (red outline) | action (primary-coloured outline, with icon) | link (text/icon only in
// the primary colour, no border — for tertiary actions such as "Export CSV").
export type ActionButton = { label: string; style?: "primary" | "secondary" | "danger" | "action" | "link"; icon?: string; target?: string };

function renderButton(b: ActionButton, key: number, onNavigate: (target?: string) => void) {
  return (
    <button
      key={key}
      type="button"
      className={b.style === "link" ? "mk-link-btn" : `mk-btn mk-btn-${b.style || "secondary"}`}
      onClick={() => onNavigate(b.target)}
    >
      {b.icon && <Icon name={b.icon} size={14} />}
      {b.label}
    </button>
  );
}

// 'splitFirst': the dialog action bar pattern — the way out on the left, cancel/hold/save on the
// right. It is automatic, decided by the caller (MockupView) from theme + page, never a schema
// prop: when true the first button is isolated on the left and the rest are pushed right. Mirrored
// in Python in server/mockup_export.py (_render_actions, split_first parameter).
export function ActionsBar({
  buttons,
  onNavigate,
  splitFirst = false,
}: {
  buttons: ActionButton[];
  onNavigate: (target?: string) => void;
  splitFirst?: boolean;
}) {
  if (splitFirst && buttons.length > 1) {
    const [first, ...rest] = buttons;
    return (
      <div className="mk-actions-row mk-actions-split">
        <div className="mk-actions-split-start">{renderButton(first, 0, onNavigate)}</div>
        <div className="mk-actions-split-end">{rest.map((b, i) => renderButton(b, i + 1, onNavigate))}</div>
      </div>
    );
  }
  return <div className="mk-actions-row">{buttons.map((b, i) => renderButton(b, i, onNavigate))}</div>;
}
