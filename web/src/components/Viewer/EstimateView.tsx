import { Fragment, useEffect, useRef, useState } from "react";
import { apiClient, ApiError, exportUrl } from "../../api/client";
import { computeEstimateTotals, devTaskSum, epicSubtotal, type EstimateTotals } from "../../lib/totals";
import type { EstimateDevTask, EstimateDoc, EstimateEpic, EstimateTask } from "../../types";
import { useToastStore } from "../../store/toastStore";
import { useReloadableDoc } from "../../hooks/useReloadableDoc";
import { Icon } from "../icons";
import AnchorButton from "./AnchorButton";
import ConfirmButton from "./ConfirmButton";
import TimelineView from "./TimelineView";
import WrapCell from "./WrapCell";

/** Table / timeline: two readings of the same estimate, not two documents. */
function ViewSwitch({
  view,
  onChange,
}: {
  view: "table" | "timeline";
  onChange: (v: "table" | "timeline") => void;
}) {
  return (
    <div className="view-switch">
      {(["table", "timeline"] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={`view-switch-btn ${view === v ? "active" : ""}`}
          onClick={() => onChange(v)}
        >
          <Icon name={v === "table" ? "table" : "trending-up"} size={13} />
          {v === "table" ? "Table" : "Timeline"}
        </button>
      ))}
    </div>
  );
}

// Unified estimate + dev tasks viewer, "Excel-like" layout:
// - the epic is NOT a column: it's a full-width grouping row (name + epic day total lined
//   up with the left-hand days column + epic actions).
// - below it, the table has two zones: left = estimate (Task | Description | Days, cells
//   merged vertically via rowSpan when the task has N dev_tasks), right = breakdown
//   (Dev Task | Description | Days | Owner, one row per dev task).
// - All-or-nothing at DOCUMENT level: the right zone renders only if at least one task in
//   the whole document has a non-empty dev_tasks. At the level of a single TASK the
//   "odd" case stays possible (right zone visible but this task has no dev tasks yet):
//   single row with the right-hand cells empty, days still editable for that task.
// - Task days: summed from below when dev_tasks isn't empty (read-only, recomputed live on
//   every dev task edit), editable otherwise.

type ColKey = "task" | "description" | "days" | "devTask" | "devDescription" | "devDays" | "owner";
type HideableKey = "description" | "devDescription" | "owner";

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  task: 240,
  description: 280,
  days: 64,
  devTask: 220,
  devDescription: 280,
  devDays: 64,
  owner: 110,
};
const MIN_WIDTHS: Record<ColKey, number> = {
  task: 140,
  description: 140,
  days: 56,
  devTask: 140,
  devDescription: 140,
  devDays: 56,
  owner: 80,
};
const TASK_ACTIONS_WIDTH = 96;
const DEV_ACTIONS_WIDTH = 60;

const HIDEABLE_COLS: { key: HideableKey; label: string }[] = [
  { key: "description", label: "Description" },
  { key: "devDescription", label: "Dev description" },
  { key: "owner", label: "Owner" },
];

type Layout = { widths: Partial<Record<ColKey, number>>; hidden: string[]; expanded: string[] };

function layoutKey(project: string): string {
  return `estimate-layout:${project}`;
}

function loadLayout(project: string): Layout | null {
  try {
    const raw = localStorage.getItem(layoutKey(project));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      widths: parsed && typeof parsed.widths === "object" && parsed.widths ? parsed.widths : {},
      hidden: Array.isArray(parsed?.hidden) ? parsed.hidden : [],
      expanded: Array.isArray(parsed?.expanded) ? parsed.expanded : [],
    };
  } catch {
    return null;
  }
}

function saveLayout(project: string, layout: Layout): void {
  localStorage.setItem(layoutKey(project), JSON.stringify(layout));
}

function nextTaskId(epic: EstimateEpic): string {
  return `${epic.id}.T${epic.tasks.length + 1}`;
}

function newTask(epic: EstimateEpic): EstimateTask {
  return { id: nextTaskId(epic), task: "New task", days: 1, description: "", dev_tasks: [] };
}

function newEpic(n: number): EstimateEpic {
  const id = `E${n}`;
  return {
    id,
    name: `${n}. New Epic`,
    tasks: [{ id: `${id}.T1`, task: "New task", days: 1, description: "", dev_tasks: [] }],
    e2e: { label: "E2E Test New Epic flow", days: 0.5 },
  };
}

function nextDevTaskId(task: EstimateTask): string {
  const prefix = `${task.id}.D`;
  const max = task.dev_tasks.reduce((m, d) => {
    if (!d.id.startsWith(prefix)) return m;
    const n = Number(d.id.slice(prefix.length));
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `${prefix}${max + 1}`;
}

function newDevTask(task: EstimateTask): EstimateDevTask {
  return { id: nextDevTaskId(task), dev_task: "New dev task", description: "", days: 0.5, owner: "" };
}

// Resize handle on the right edge of a header: drag via Pointer Events, updates the
// column width in "widths" while staying above the allowed minimum.
function ColResizeHandle({
  colKey,
  widths,
  setWidths,
}: {
  colKey: ColKey;
  widths: Record<ColKey, number>;
  setWidths: (fn: (w: Record<ColKey, number>) => Record<ColKey, number>) => void;
}) {
  const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[colKey];
    const min = MIN_WIDTHS[colKey];
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(min, Math.round(startW + (ev.clientX - startX)));
      setWidths((cur) => ({ ...cur, [colKey]: w }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return <span className="col-resize-handle" onPointerDown={onPointerDown} />;
}

// The "columns" dropdown in the toolbar: checkboxes to hide Description/Dev description/
// Owner (Task, Days, Dev Task and Dev days can never be hidden — they're the load-bearing
// structure).
function ColumnMenu({ hidden, onToggle }: { hidden: Set<string>; onToggle: (key: HideableKey) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="col-menu-wrap" ref={wrapRef}>
      <button type="button" className="ghost-btn" title="columns" onClick={() => setOpen((v) => !v)}>
        <Icon name="columns" size={14} />
        <span>columns</span>
      </button>
      {open && (
        <div className="col-menu-popover">
          {HIDEABLE_COLS.map((c) => (
            <label key={c.key} className="col-menu-item">
              <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => onToggle(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EstimateView({
  project,
  tick,
  onSaved,
  onDirtyChange,
  onTotals,
}: {
  project: string;
  tick: number;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Pushes the totals up to the viewer header (short recap next to the title).
   *  It lives here because this view is what loads the document: the header never
   *  re-reads it. */
  onTotals?: (t: EstimateTotals | null) => void;
}) {
  const { doc, setDoc, loadError, dirty, setDirty, stale, reloadDiscardingChanges } =
    useReloadableDoc<EstimateDoc>(project, "estimate", tick);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"table" | "timeline">("table");

  // Layout persisted per project: column widths, hidden columns, expanded rows.
  const storedLayout = useRef(loadLayout(project)).current;
  const [widths, setWidths] = useState<Record<ColKey, number>>({
    ...DEFAULT_WIDTHS,
    ...(storedLayout?.widths ?? {}),
  });
  const [hidden, setHidden] = useState<Set<string>>(new Set(storedLayout?.hidden ?? []));
  const [expanded, setExpanded] = useState<Set<string>>(new Set(storedLayout?.expanded ?? []));
  const expandDefaultDone = useRef(storedLayout !== null);

  // Pushes "dirty" up to ProjectView: it drives the auto-opening of deliverables at the
  // end of a turn (if the user is editing here, a new turn must not yank the view away).
  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // No layout saved for this project: by default expand every task that already has a
  // dev_tasks breakdown (there's nothing to expand otherwise).
  useEffect(() => {
    if (expandDefaultDone.current || !doc) return;
    // dev_tasks is required by schemas/estimate.schema.json, but documents written before
    // the field existed can still be sitting on disk without it: fall back to an empty
    // breakdown rather than crashing into the error boundary (same convention as
    // lib/items.ts, which flattens the same estimate for the timeline).
    const ids = doc.epics.flatMap((e) => e.tasks.filter((t) => (t.dev_tasks ?? []).length > 0).map((t) => t.id));
    if (ids.length) setExpanded(new Set(ids));
    expandDefaultDone.current = true;
  }, [doc]);

  useEffect(() => {
    saveLayout(project, { widths, hidden: [...hidden], expanded: [...expanded] });
  }, [project, widths, hidden, expanded]);

  // The header recap follows changes that haven't been saved yet: if the user edits a day
  // value in the table, the total up top moves with it. Clears itself on unmount.
  useEffect(() => {
    onTotals?.(doc ? computeEstimateTotals(doc) : null);
    return () => onTotals?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  if (loadError) return <div className="viewer-empty">Estimate load error: {loadError}</div>;
  if (!doc) return <div className="spinner-block"><span className="spinner" />loading…</div>;

  const mutate = (fn: (d: EstimateDoc) => EstimateDoc) => {
    setDoc((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.putDoc(project, "estimate", doc);
      setDirty(false);
      useToastStore.getState().push("Estimate saved");
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save error");
    } finally {
      setSaving(false);
    }
  };

  const totals = computeEstimateTotals(doc);

  const isVisible = (key: HideableKey) => !hidden.has(key);

  // All-or-nothing AT DOCUMENT LEVEL: the right zone (breakdown) exists only if at least
  // one task, in any epic, has a non-empty dev_tasks (falling back to [] for legacy tasks
  // that predate the field — see the comment on expandDefaultDone's effect above).
  const hasBreakdown = doc.epics.some((e) => e.tasks.some((t) => (t.dev_tasks ?? []).length > 0));

  const leftNameSpan = 1 + (isVisible("description") ? 1 : 0); // Task (+ Description)
  const rightDataSpan = hasBreakdown
    ? 1 + (isVisible("devDescription") ? 1 : 0) + 1 + (isVisible("owner") ? 1 : 0) // Dev Task, [Description], Days, [Owner]
    : 0;
  // total table columns: Task, [Description], Days, task-actions, [right zone], [dev actions]
  const totalCols = leftNameSpan + 1 + 1 + rightDataSpan + (hasBreakdown ? 1 : 0);
  const totalsTrailing = totalCols - leftNameSpan - 1;

  const expandableTaskIds = doc.epics.flatMap((e) => e.tasks.filter((t) => (t.dev_tasks ?? []).length > 0).map((t) => t.id));
  const allExpanded = expandableTaskIds.length > 0 && expandableTaskIds.every((id) => expanded.has(id));

  const toggleExpandAll = () => setExpanded(allExpanded ? new Set() : new Set(expandableTaskIds));
  const toggleExpand = (taskId: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  const toggleHidden = (key: HideableKey) =>
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addDevTask = (ei: number, ti: number) => {
    const taskId = doc.epics[ei].tasks[ti].id;
    mutate((d) => {
      const task = d.epics[ei].tasks[ti];
      // A legacy task predating dev_tasks may not have the array at all yet: the "+ dev
      // task" button is always shown (it isn't gated on hasDevTasks), so this is the one
      // write path that can hit a genuinely missing field rather than just an empty one.
      task.dev_tasks ??= [];
      task.dev_tasks.push(newDevTask(task));
      task.days = devTaskSum(task);
      return d;
    });
    setExpanded((cur) => new Set(cur).add(taskId));
  };

  const updateDevTask = (ei: number, ti: number, di: number, patch: Partial<EstimateDevTask>) =>
    mutate((d) => {
      const task = d.epics[ei].tasks[ti];
      Object.assign(task.dev_tasks[di], patch);
      if ("days" in patch) task.days = devTaskSum(task);
      return d;
    });

  const removeDevTask = (ei: number, ti: number, di: number) =>
    mutate((d) => {
      const task = d.epics[ei].tasks[ti];
      task.dev_tasks.splice(di, 1);
      // if dev_tasks remain, days stays the derived sum; if the array empties out,
      // task.days keeps the last value (the last sum) and becomes editable by hand again.
      if (task.dev_tasks.length > 0) task.days = devTaskSum(task);
      return d;
    });

  const devTasksStatus = doc.meta.dev_tasks_status;

  // The timeline isn't a deliverable of its own: it's the same estimate seen on the time
  // axis. It lives here as an alternative view, not as a separate tab.
  if (view === "timeline")
    return (
      <div className="doc-table-wrap">
        <ViewSwitch view={view} onChange={setView} />
        <TimelineView project={project} estimate={doc} onSaved={onSaved} />
      </div>
    );

  return (
    <div className="doc-table-wrap">
      <ViewSwitch view={view} onChange={setView} />
      {stale && (
        <div className="stale-banner">
          <Icon name="triangle-alert" size={15} />
          <span>The document changed on disk (updated in the meantime). Unsaved changes here were left untouched.</span>
          <ConfirmButton label="reload from disk" confirmLabel="you'll lose your changes: confirm" onConfirm={reloadDiscardingChanges} />
        </div>
      )}

      <div className="table-toolbar">
        <button
          type="button"
          className="ghost-btn"
          disabled={expandableTaskIds.length === 0}
          onClick={toggleExpandAll}
        >
          <Icon name={allExpanded ? "chevron-down" : "chevron-right"} size={14} />
          <span>{allExpanded ? "collapse all" : "expand all"}</span>
        </button>
        <ColumnMenu hidden={hidden} onToggle={toggleHidden} />
        <span className="spacer" />
        {devTasksStatus && <span className={`doc-status-badge ${devTasksStatus}`}>dev tasks: {devTasksStatus}</span>}
        <a className="ghost-btn" href={exportUrl(project, "dev_tasks.xlsx")}>
          <Icon name="download" size={14} />
          <span>dev tasks .xlsx</span>
        </a>
      </div>

      <table className="doc-table estimate-table">
        <colgroup>
          <col style={{ width: widths.task }} />
          {isVisible("description") && <col style={{ width: widths.description }} />}
          <col style={{ width: widths.days }} />
          <col style={{ width: TASK_ACTIONS_WIDTH }} />
          {hasBreakdown && (
            <>
              <col style={{ width: widths.devTask }} className="dev-zone-col" />
              {isVisible("devDescription") && <col style={{ width: widths.devDescription }} />}
              <col style={{ width: widths.devDays }} />
              {isVisible("owner") && <col style={{ width: widths.owner }} />}
              <col style={{ width: DEV_ACTIONS_WIDTH }} />
            </>
          )}
        </colgroup>
        <thead>
          <tr>
            <th>Task<ColResizeHandle colKey="task" widths={widths} setWidths={setWidths} /></th>
            {isVisible("description") && (
              <th>Description<ColResizeHandle colKey="description" widths={widths} setWidths={setWidths} /></th>
            )}
            <th>Days<ColResizeHandle colKey="days" widths={widths} setWidths={setWidths} /></th>
            <th className="th-actions" />
            {hasBreakdown && (
              <>
                <th className="dev-zone-col">Dev Task<ColResizeHandle colKey="devTask" widths={widths} setWidths={setWidths} /></th>
                {isVisible("devDescription") && (
                  <th>Description<ColResizeHandle colKey="devDescription" widths={widths} setWidths={setWidths} /></th>
                )}
                <th>Days<ColResizeHandle colKey="devDays" widths={widths} setWidths={setWidths} /></th>
                {isVisible("owner") && (
                  <th>Owner<ColResizeHandle colKey="owner" widths={widths} setWidths={setWidths} /></th>
                )}
                <th className="th-actions" />
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {doc.epics.map((epic, ei) => {
            const epicTotal = epicSubtotal(epic);
            return (
              <Fragment key={epic.id}>
                <tr className="epic-header">
                  <td colSpan={leftNameSpan}>
                    <input
                      className="cell-input"
                      value={epic.name}
                      onChange={(e) => mutate((d) => { d.epics[ei].name = e.target.value; return d; })}
                    />
                  </td>
                  <td className="num epic-total">{epicTotal} days</td>
                  <td className="row-actions">
                    <div className="cell-actions">
                      <button
                        type="button"
                        className="ghost-btn small"
                        title="add task"
                        onClick={() => mutate((d) => { d.epics[ei].tasks.push(newTask(d.epics[ei])); return d; })}
                      >
                        <Icon name="plus" size={13} />
                        <span>task</span>
                      </button>
                      <ConfirmButton
                        className="icon-btn danger"
                        icon="trash-2"
                        iconSize={13}
                        label="delete epic"
                        confirmLabel="confirm deletion?"
                        onConfirm={() => mutate((d) => { d.epics.splice(ei, 1); return d; })}
                      />
                    </div>
                  </td>
                  {hasBreakdown && <td className="dev-zone-col" colSpan={rightDataSpan + 1} />}
                </tr>

                {epic.tasks.map((task, ti) => {
                  // Fall back to [] for tasks written before dev_tasks was mandatory (see
                  // the comment above expandDefaultDone's effect).
                  const devTasks = task.dev_tasks ?? [];
                  const hasDevTasks = devTasks.length > 0;
                  const isExpanded = expanded.has(task.id);
                  const rowSpan = hasDevTasks && isExpanded ? devTasks.length : 1;
                  const firstDevTask = devTasks[0];

                  return (
                    <Fragment key={task.id}>
                      <tr className="task-row">
                        <td className="task-cell" rowSpan={rowSpan}>
                          <div className="cell-flex">
                            {hasDevTasks && (
                              <button
                                type="button"
                                className="icon-btn row-expand-btn"
                                title={isExpanded ? "collapse" : "expand"}
                                onClick={() => toggleExpand(task.id)}
                              >
                                <Icon name={isExpanded ? "chevron-down" : "chevron-right"} size={13} />
                              </button>
                            )}
                            <input
                              className="cell-input"
                              value={task.task}
                              onChange={(e) => mutate((d) => { d.epics[ei].tasks[ti].task = e.target.value; return d; })}
                            />
                          </div>
                        </td>
                        {isVisible("description") && (
                          <td className="wrap-cell" rowSpan={rowSpan}>
                            <WrapCell
                              value={task.description}
                              onChange={(v) => mutate((d) => { d.epics[ei].tasks[ti].description = v; return d; })}
                              placeholder="Functional description…"
                            />
                          </td>
                        )}
                        <td className="num" rowSpan={rowSpan}>
                          {hasDevTasks ? (
                            <span className="days-derived" title="Sum of the dev tasks — expand the row to change it">
                              {task.days}
                            </span>
                          ) : (
                            <input
                              className="cell-input num-input"
                              type="number" step="0.25" min="0"
                              value={task.days}
                              onChange={(e) => mutate((d) => { d.epics[ei].tasks[ti].days = Number(e.target.value) || 0; return d; })}
                            />
                          )}
                        </td>
                        <td className="row-actions" rowSpan={rowSpan}>
                          <div className="cell-actions">
                            <AnchorButton project={project} file="estimate.json" anchorRef={task.id} label={`${epic.name} — ${task.task} (${task.days} days)`} />
                            <button type="button" className="icon-btn" title="+ dev task" onClick={() => addDevTask(ei, ti)}>
                              <Icon name="plus" size={13} />
                            </button>
                            <ConfirmButton
                              className="icon-btn danger"
                              icon="trash-2"
                              iconSize={13}
                              label="delete task"
                              confirmLabel="sure?"
                              onConfirm={() => mutate((d) => { d.epics[ei].tasks.splice(ti, 1); return d; })}
                            />
                          </div>
                        </td>

                        {hasBreakdown && !hasDevTasks && (
                          <td className="dev-empty-cell dev-zone-col" colSpan={rightDataSpan + 1} />
                        )}
                        {hasBreakdown && hasDevTasks && !isExpanded && (
                          <td className="dev-hint-cell dev-zone-col" colSpan={rightDataSpan + 1}>
                            <span className="dev-hint">{devTasks.length} dev tasks</span>
                          </td>
                        )}
                        {hasBreakdown && hasDevTasks && isExpanded && firstDevTask && (
                          <DevTaskCells
                            project={project}
                            task={task}
                            dt={firstDevTask}
                            isVisible={isVisible}
                            onUpdate={(patch) => updateDevTask(ei, ti, 0, patch)}
                            onRemove={() => removeDevTask(ei, ti, 0)}
                          />
                        )}
                      </tr>

                      {hasDevTasks && isExpanded && devTasks.slice(1).map((dt, idx) => {
                        const di = idx + 1;
                        return (
                          <tr className="dev-task-row" key={dt.id}>
                            <DevTaskCells
                              project={project}
                              task={task}
                              dt={dt}
                              isVisible={isVisible}
                              onUpdate={(patch) => updateDevTask(ei, ti, di, patch)}
                              onRemove={() => removeDevTask(ei, ti, di)}
                            />
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}

                {epic.e2e ? (
                  <tr className="e2e-row">
                    <td colSpan={leftNameSpan}>
                      <input
                        className="cell-input"
                        value={epic.e2e.label}
                        onChange={(e) => mutate((d) => { const cur = d.epics[ei].e2e; if (cur) cur.label = e.target.value; return d; })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="cell-input num-input"
                        type="number" step="0.25" min="0"
                        value={epic.e2e.days}
                        onChange={(e) => mutate((d) => { const cur = d.epics[ei].e2e; if (cur) cur.days = Number(e.target.value) || 0; return d; })}
                      />
                    </td>
                    <td className="row-actions">
                      <div className="cell-actions">
                        <AnchorButton project={project} file="estimate.json" anchorRef={`${epic.id}.E2E`} label={`${epic.name} — ${epic.e2e.label} (${epic.e2e.days} days)`} />
                      </div>
                    </td>
                    {hasBreakdown && <td className="dev-zone-col" colSpan={rightDataSpan + 1} />}
                  </tr>
                ) : (
                  <tr className="e2e-row">
                    <td colSpan={totalCols}>
                      <button
                        type="button"
                        className="ghost-btn small"
                        onClick={() => mutate((d) => { d.epics[ei].e2e = { label: `E2E Test ${epic.name} flow`, days: 0.5 }; return d; })}
                      >
                        <Icon name="plus" size={13} />
                        <span>E2E test</span>
                      </button>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}

          <tr className="subtotal-row">
            <td colSpan={leftNameSpan}>Dev total</td>
            <td className="num">{totals.devTotal}</td>
            <td colSpan={totalsTrailing} />
          </tr>
          <tr className="subtotal-row">
            <td colSpan={leftNameSpan}>
              Contingency (
              <input
                className="cell-input inline-number"
                type="number" min="0" value={doc.meta.contingency_pct}
                onChange={(e) => mutate((d) => { d.meta.contingency_pct = Number(e.target.value) || 0; return d; })}
              />
              %)
            </td>
            <td className="num">{totals.contingency}</td>
            <td colSpan={totalsTrailing} />
          </tr>
          <tr className="total-row">
            <td colSpan={leftNameSpan}>TOTAL</td>
            <td className="num">{totals.grandTotal}</td>
            <td colSpan={totalsTrailing} />
          </tr>
        </tbody>
      </table>

      <div className="doc-toolbar">
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => mutate((d) => { d.epics.push(newEpic(d.epics.length + 1)); return d; })}
        >
          <Icon name="plus" size={13} />
          <span>epic</span>
        </button>
        <span className="spacer" />
        {error && <span className="error-text">{error}</span>}
        {dirty && !error && <span className="vh-dirty">unsaved changes</span>}
        <button className="mini-btn primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "saving…" : "save"}
        </button>
      </div>
    </div>
  );
}

// Cells of the right-hand zone (breakdown) for a single dev task — shared between the
// first row (merged into the task's <tr>, after the left-hand cells) and the following
// rows (each in its own <tr>).
function DevTaskCells({
  project,
  task,
  dt,
  isVisible,
  onUpdate,
  onRemove,
}: {
  project: string;
  task: EstimateTask;
  dt: EstimateDevTask;
  isVisible: (key: HideableKey) => boolean;
  onUpdate: (patch: Partial<EstimateDevTask>) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <td className="dev-task-cell wrap-cell dev-zone-col">
        <WrapCell value={dt.dev_task} onChange={(v) => onUpdate({ dev_task: v })} />
      </td>
      {isVisible("devDescription") && (
        <td className="wrap-cell">
          <WrapCell value={dt.description} onChange={(v) => onUpdate({ description: v })} placeholder="Technical description…" />
        </td>
      )}
      <td className="num">
        <input
          className="cell-input num-input"
          type="number" step="0.25" min="0"
          value={dt.days}
          onChange={(e) => onUpdate({ days: Number(e.target.value) || 0 })}
        />
      </td>
      {isVisible("owner") && (
        <td>
          <input className="cell-input" value={dt.owner ?? ""} onChange={(e) => onUpdate({ owner: e.target.value })} placeholder="—" />
        </td>
      )}
      <td className="row-actions">
        <div className="cell-actions">
          <AnchorButton project={project} file="estimate.json" anchorRef={dt.id} label={`${task.task} — ${dt.dev_task} (${dt.days} days)`} />
          <ConfirmButton className="icon-btn danger" icon="trash-2" iconSize={12} label="delete dev task" confirmLabel="sure?" onConfirm={onRemove} />
        </div>
      </td>
    </>
  );
}
