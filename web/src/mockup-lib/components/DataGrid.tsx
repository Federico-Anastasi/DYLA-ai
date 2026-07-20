import { useState } from "react";
import { Icon } from "../icons";

// Data table / record list (schema type 'grid'). columns[].kind picks how the cell renders: text
// (default) | id-link | chip | progress | sla | status. The 'status' logic is a keyword heuristic
// (see statusIconFor), mirrored 1:1 in server/mockup_export.py (_status_icon_for) so the preview
// and the export stay identical.
export type GridColumn = { key: string; label: string; kind?: "text" | "id-link" | "chip" | "progress" | "sla" | "status" };
export type GridAction = { label: string; target?: string; icon?: string; variant?: "button" | "link" };

export function statusIconFor(value: string): { icon: string; cls: string } | null {
  const v = String(value || "").toLowerCase();
  if (/complet|approv|done|\bok\b/.test(v)) return { icon: "check-circle", cls: "mk-status-success" };
  if (/pending|waiting|hold|paused|review/.test(v)) return { icon: "pause", cls: "mk-status-warning" };
  if (/automat|bot|sent/.test(v)) return { icon: "bot", cls: "mk-status-info" };
  if (/reject|fail|error|\bko\b/.test(v)) return { icon: "alert-circle", cls: "mk-status-error" };
  return null;
}

function Cell({ col, row, onNavigate, rowActions }: { col: GridColumn; row: Record<string, unknown>; onNavigate: (t?: string) => void; rowActions: GridAction[] }) {
  const raw = row[col.key];
  const value = String(raw ?? "");
  switch (col.kind) {
    case "id-link": {
      const target = rowActions[0]?.target;
      return (
        <button type="button" className="mk-cell-link" onClick={() => target && onNavigate(target)}>
          {value}
        </button>
      );
    }
    case "chip":
      return <span className="mk-cell-chip">{value}</span>;
    case "progress": {
      const pct = Math.max(0, Math.min(100, Number(raw) || 0));
      return (
        <div className="mk-cell-progress" title={`${pct}%`}>
          <div className="mk-cell-progress-track">
            <div className="mk-cell-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      );
    }
    case "sla": {
      const ok = /^(ok|true|yes)$/i.test(value);
      return (
        <span className={`mk-cell-sla ${ok ? "mk-sla-ok" : "mk-sla-ko"}`}>
          <Icon name={ok ? "check-circle" : "alert-circle"} size={14} />
          {value}
        </span>
      );
    }
    case "status": {
      const st = statusIconFor(value);
      return (
        <span className={`mk-cell-status ${st?.cls ?? ""}`}>
          {st && <Icon name={st.icon} size={14} />}
          {value}
        </span>
      );
    }
    default:
      return <>{value}</>;
  }
}

export function DataGrid({
  title,
  columns,
  rows,
  actions = [],
  searchable = true,
  paginationLabel,
  actionsPosition = "end",
  onNavigate,
}: {
  title?: string;
  columns: GridColumn[];
  rows: Record<string, unknown>[];
  actions?: GridAction[];
  searchable?: boolean;
  paginationLabel?: string;
  // "start" = actions column first (standard theme). "end" = actions column last (plain theme).
  // "none" = no actions column at all (compact theme: row navigation goes only through a
  // kind='id-link' column, which still uses actions[0].target as its destination but shows no
  // buttons). See MockupView.tsx (gridActionsPosition) and the Python mirror
  // (_grid_actions_position in server/mockup_export.py): same function, same result.
  actionsPosition?: "start" | "end" | "none";
  onNavigate: (target?: string) => void;
}) {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const filteredRows = q ? rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q))) : rows;
  const showActionsColumn = actionsPosition !== "none" && actions.length > 0;
  const colSpan = columns.length + (showActionsColumn ? 1 : 0);

  const actionsCell = () =>
    showActionsColumn && (
      <td className="mk-col-actions" key="actions">
        {actions.map((a, ai) => (
          <button
            key={ai}
            type="button"
            className={a.variant === "link" ? "mk-link-btn" : "mk-btn mk-btn-small mk-btn-secondary"}
            onClick={() => onNavigate(a.target)}
          >
            {a.icon && <Icon name={a.icon} size={13} />}
            {a.label}
          </button>
        ))}
      </td>
    );

  return (
    <div className="mk-grid-block">
      {(title || searchable) && (
        <div className="mk-grid-toolbar">
          {title && <div className="mk-grid-title">{title}</div>}
          {searchable && (
            <div className="mk-search-box">
              <Icon name="search" size={14} />
              <input
                type="text"
                className="mk-grid-search"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
        </div>
      )}
      <div className="mk-grid-wrap">
        <table className="mk-grid-table">
          <thead>
            <tr>
              {actionsPosition === "start" && showActionsColumn && <th className="mk-col-actions">Actions</th>}
              {columns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
              {actionsPosition === "end" && showActionsColumn && <th className="mk-col-actions">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr className="mk-empty-row">
                <td colSpan={Math.max(colSpan, 1)}>No items</td>
              </tr>
            ) : (
              filteredRows.map((row, ri) => (
                <tr key={ri}>
                  {actionsPosition === "start" && actionsCell()}
                  {columns.map((col) => (
                    <td key={col.key}>
                      <Cell col={col} row={row} onNavigate={onNavigate} rowActions={actions} />
                    </td>
                  ))}
                  {actionsPosition === "end" && actionsCell()}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {paginationLabel && (
        <div className="mk-grid-pagination">
          <span>{paginationLabel}</span>
          <span className="mk-pagination-nav">
            <Icon name="chevrons-left" size={14} />
            <Icon name="chevron-left" size={14} />
            <Icon name="chevron-right" size={14} />
            <Icon name="chevrons-right" size={14} />
          </span>
        </div>
      )}
    </div>
  );
}
