import { useEffect, useMemo, useState } from "react";
import { ApiError, apiClient, exportUrl } from "../../api/client";
import { Icon } from "../icons";
import { useToastStore } from "../../store/toastStore";
import { Calendar, addDays, fromISO, mondayOf, type ISODate } from "../../lib/calendar";
import { schedule, distribute, reconcile, moveItem, type Bar } from "../../lib/lanes";
import { extractItems } from "../../lib/items";
import { computeMetrics, type Metrics } from "../../lib/timelineMetrics";
import {
  buildAxis,
  monthBands,
  weekBands,
  stack,
  segmentWeight,
  rect,
  segments,
} from "../../lib/timelineLayout";
import type { ItemStatus, EstimateDoc, TimelineLane, TimelineDev, TimelineDoc } from "../../types";

// The axis carries ONLY working days: weekends and holidays are not columns, so the
// length of a bar reads directly as days of work. Non-working days stay visible as a GAP
// (GAP_W) between two non-consecutive columns, and bars that straddle them get split:
// without the gap a Monday-to-Friday stretch would look like seven continuous days of
// work. The gap follows the calendar, not the labels: a month change between two
// consecutive days produces no gap at all.
//
// Width of a day: sized on the shortest dev task you actually run into (0.5 days = half a
// column), because even that half column has to fit a code like "E10.T10.D10" whole.
// Hence the 140px: 70 for half a day, against the ~62 the longest text takes up.
const DAY_W = 140;
const GAP_W = 18;
// Cards carry two lines (code and task name), so the lane is tall.
const CARD_H = 44;
const ROW_H = CARD_H + 6;

// Width thresholds for the card content, measured on the longest text that can turn up (a
// code like "E10.T10.D10"). Below each threshold the corresponding element disappears
// instead of being clipped: whatever you can see is always fully readable, and what's
// missing stays in the tooltip and the detail panel.
const W_CODE = 70; // code at full size
const W_CODE_MIN = 54; // code at reduced size; below that, the card stays mute
const W_DAYS = 96; // code + days on the same line
const W_NAME = 110; // second line with the task name

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Colour means PROGRESS: that's the information you read at a glance on an operational
// board. The technical layer is planning data, not status, and sits inside the card as a
// badge.
const STATUSES: { id: ItemStatus; label: string; color: string }[] = [
  { id: "todo", label: "To do", color: "#8a8079" },
  { id: "wip", label: "In progress", color: "#d08a2e" },
  { id: "done", label: "Done", color: "#4caf7d" },
];
const STATUS_COLOR: Record<ItemStatus, string> = Object.fromEntries(
  STATUSES.map((s) => [s.id, s.color]),
) as Record<ItemStatus, string>;

// Short layer tag for the badge: it has to fit in a few pixels inside the card.
const LAYER_BADGE: Record<number, string> = { 1: "DM", 2: "UI", 3: "LOG", 4: "E2E" };
const LAYER_NAME: Record<number, string> = {
  1: "Data model",
  2: "Interfaces",
  3: "Logic and integrations",
  4: "E2E tests",
};

function today(): ISODate {
  return new Date().toISOString().slice(0, 10);
}

function emptyConfig(project: string): TimelineDoc {
  return {
    meta: { project, date: today(), status: "draft" },
    start_date: mondayOf(today()),
    team: [{ id: "dev1", name: "Developer 1" }],
    holidays: [],
    lanes: [],
  };
}

/** Days come in steps of 0.25: without rounding, 26.5 + 0.25 prints a float tail. */
function fmtDays(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function fmtDate(d: ISODate): string {
  const dt = fromISO(d);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
}

export default function TimelineView({
  project,
  estimate,
  onSaved,
}: {
  project: string;
  /** The estimate already loaded by the parent: the timeline is a view of it, not another document. */
  estimate: EstimateDoc;
  onSaved: () => void;
}) {
  const [config, setConfig] = useState<TimelineDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // Drag & drop: id of the item being dragged and the developer under the cursor.
  const [dragged, setDragged] = useState<string | null>(null);
  const [devTarget, setDevTarget] = useState<string | null>(null);
  // Where the card would land right now: x in pixels and index in the lane.
  const [dropHint, setDropHint] = useState<{ x: number; position: number } | null>(null);

  // timeline.json only holds the planning parameters and may not exist yet
  // (404 -> start from an empty config, it isn't an error).
  useEffect(() => {
    let alive = true;
    apiClient
      .getDoc(project, "timeline")
      .then((d) => alive && setConfig(d))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) setConfig(emptyConfig(project));
        else setLoadError("Timeline configuration load error");
      });
    return () => {
      alive = false;
    };
  }, [project]);

  // The lanes are the state of the plan; if they're missing (or the estimate changed) they
  // get reconciled before the calendar is laid out. Automatic distribution only kicks in
  // when there's no plan at all yet.
  const lanes = useMemo<TimelineLane[] | null>(() => {
    if (!config) return null;
    const items = extractItems(estimate);
    const devs = config.team.map((d) => d.id);
    return config.lanes?.length
      ? reconcile(config.lanes, items, devs)
      : distribute(items, devs);
  }, [estimate, config]);

  const plan = useMemo(
    () => (config && lanes ? schedule(estimate, config, lanes) : null),
    [estimate, config, lanes],
  );

  const mutate = (fn: (c: TimelineDoc) => TimelineDoc) => {
    setConfig((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
  };

  /** Status of an item: "todo" is the default for everything that hasn't been moved. */
  const statusOf = (id: string): ItemStatus =>
    (config?.states ?? []).find((s) => s.dev_task_id === id)?.status ?? "todo";

  /** Changes the progress of an item. Back to "todo" and the row disappears from the document. */
  const changeStatus = (dev_task_id: string, status: ItemStatus) =>
    mutate((c) => {
      const others = (c.states ?? []).filter((s) => s.dev_task_id !== dev_task_id);
      return { ...c, states: status === "todo" ? others : [...others, { dev_task_id, status }] };
    });

  /**
   * Drag & drop: moves an item into a developer's lane, at an exact position. It's a
   * splice between two arrays — the following items shift along, nothing else moves.
   */
  const moveItemTo = (itemId: string, dev: string, position: number) =>
    mutate((c) => ({ ...c, lanes: moveItem(lanes ?? [], itemId, dev, position) }));

  /** Redistributes everything from scratch, balancing: undoes every manual move. */
  const redistribute = () =>
    mutate((c) => ({
      ...c,
      lanes: distribute(extractItems(estimate), c.team.map((d) => d.id)),
    }));

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      // `lanes` (the memo above) is what is actually on screen: as long as nobody has
      // dragged a card, config.lanes stays whatever it was when loaded (possibly empty,
      // or stale against the current team/estimate), because only moveItemTo/redistribute
      // write into it. Saving config as-is would persist that empty/stale array and wipe
      // out the auto-distributed plan the user is looking at on the next reload.
      await apiClient.putDoc(project, "timeline", { ...config, lanes: lanes ?? config.lanes ?? [] });
      setDirty(false);
      useToastStore.getState().push("Plan saved");
      onSaved();
    } catch (e) {
      useToastStore
        .getState()
        .push(e instanceof ApiError ? `Error: ${e.message}` : "Save error");
    } finally {
      setSaving(false);
    }
  };

  if (loadError) return <div className="viewer-empty">{loadError}</div>;
  if (!config || !plan)
    return (
      <div className="spinner-block">
        <span className="spinner" />
        loading…
      </div>
    );

  if (plan.bars.length === 0 && plan.unplanned.length === 0)
    return (
      <div className="viewer-empty">
        The estimate has no dev tasks to plan yet. Generate them with the /dev-tasks skill.
      </div>
    );

  // The axis carries working days only (holidays and weekends excluded for everyone).
  // Individual time off, on the other hand, stays as visible columns, shaded on that
  // person's row: it's a gap for them, not for the project.
  const cal = new Calendar(config.holidays ?? [], config.team);
  const days: ISODate[] = [];
  for (let d = plan.from; d <= plan.to; d = addDays(d, 1)) if (!cal.isHoliday(d)) days.push(d);

  const axis = buildAxis(days, DAY_W, GAP_W);
  const width = axis.width;

  const barsPerDev = new Map<string, Bar[]>(config.team.map((d) => [d.id, []]));
  for (const b of plan.bars) barsPerDev.get(b.dev)?.push(b);

  // Two-level header: months on top, weeks below.
  const months = monthBands(days, axis, DAY_W, (d) => {
    const dt = fromISO(d);
    return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
  });
  const weeks = weekBands(days, axis, DAY_W, fmtDate);

  const metrics = computeMetrics(plan.bars, config, plan, today());

  /**
   * Where the card would land if you dropped it right now: the position in the lane and
   * the x of the marker. The same function feeds the preview while dragging and the real
   * drop, so the mark you see is exactly where the card will go.
   *
   * The comparison is against the CENTRE of each card: drop on the right half of a card
   * and you land after it.
   */
  const dropPoint = (dev: string, itemId: string, px: number) => {
    const lane = (barsPerDev.get(dev) ?? [])
      .filter((b) => b.id !== itemId)
      .sort((a, b) => a.position - b.position);
    const edge = (b: (typeof lane)[number], end: boolean) =>
      (axis.x.get(end ? b.to : b.from) ?? 0) + (end ? b.endOffset : b.startOffset) * DAY_W;

    const before = lane.filter((b) => (edge(b, false) + edge(b, true)) / 2 < px);
    const position = before.length;
    // The marker sits between the previous card and the next one.
    const x = position === 0 ? 0 : edge(before[before.length - 1], true);
    return { x, position };
  };

  const detail = plan.bars.find((b) => b.id === selected) ?? null;

  return (
    <div className="timeline-view">
      <div className="timeline-toolbar">
        <button className="ghost-btn" onClick={() => setPanelOpen((v) => !v)}>
          <Icon name={panelOpen ? "chevron-down" : "chevron-right"} size={14} />
          Team and calendar
        </button>
        <span className="timeline-recap">
          {fmtDate(plan.from)} → {fmtDate(plan.to)} · {days.length} working days ·{" "}
          {config.team.length} {config.team.length === 1 ? "developer" : "developers"}
        </span>
        <span className="spacer" />
        <button className="ghost-btn" onClick={redistribute} title="rebalance the load, discarding manual moves">
          <Icon name="refresh-cw" size={14} />
          rebalance
        </button>
        <a className="ghost-btn" href={exportUrl(project, "timeline.xlsx")}>
          <Icon name="download" size={14} />
          timeline .xlsx
        </a>
        <button className="mini-btn primary" onClick={save} disabled={!dirty || saving}>
          {saving ? "saving…" : "Save"}
        </button>
      </div>

      {panelOpen && <ConfigPanel config={config} load={plan.loadPerDev} onChange={mutate} />}

      {plan.unplanned.length > 0 && (
        <div className="timeline-warning">
          {plan.unplanned.length} items assigned to nobody:{" "}
          {plan.unplanned.map((i) => i.id).join(", ")}
        </div>
      )}

      <MetricsBar metrics={metrics} />

      <div className="timeline-scroll">
        <div className="timeline-grid" style={{ width: width + 180 }}>
          <div className="timeline-head">
            <div className="timeline-corner" />
            <div style={{ width }}>
              <div className="timeline-months">
                {months.map((m) => (
                  <div key={m.key} className="timeline-month" style={{ left: m.left, width: m.width }}>
                    {m.label}
                  </div>
                ))}
              </div>
              <div className="timeline-weeks">
                {weeks.map((w) => (
                  <div key={w.key} className="timeline-week" style={{ left: w.left, width: w.width }}>
                    {w.label}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {config.team.map((dev) => {
            const rows = stack(barsPerDev.get(dev.id) ?? []);
            return (
              <div key={dev.id} className="timeline-row">
                <div className="timeline-dev">
                  <span className="timeline-dev-name">{dev.name}</span>
                  <span className="timeline-dev-load">{fmtDays(plan.loadPerDev[dev.id] ?? 0)} days</span>
                </div>
                <div
                  className={`timeline-track ${devTarget === dev.id ? "drop" : ""}`}
                  style={{ width, height: ROW_H * Math.max(1, rows.length) + 6 }}
                  onDragOver={(e) => {
                    // Without preventDefault the browser refuses the drop.
                    if (!dragged) return;
                    e.preventDefault();
                    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
                    setDevTarget(dev.id);
                    setDropHint(dropPoint(dev.id, dragged, px));
                  }}
                  onDragLeave={() => {
                    setDevTarget((d) => (d === dev.id ? null : d));
                    setDropHint(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = dragged ?? e.dataTransfer.getData("text/plain");
                    if (id) {
                      const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
                      moveItemTo(id, dev.id, dropPoint(dev.id, id, px).position);
                    }
                    setDragged(null);
                    setDevTarget(null);
                    setDropHint(null);
                  }}
                >
                  {days.map((d) =>
                    cal.isOnLeave(dev.id, d) ? (
                      <div
                        key={d}
                        className="timeline-off"
                        style={{ left: axis.x.get(d)!, width: DAY_W }}
                        title="time off"
                      />
                    ) : null,
                  )}
                  {devTarget === dev.id && dropHint && (
                    <div className="timeline-dropmark" style={{ left: dropHint.x }} />
                  )}
                  {axis.breaks.map((g) => (
                    <div
                      key={g.key}
                      className="timeline-weekend"
                      style={{ left: g.left, width: GAP_W }}
                      title="non-working days"
                    />
                  ))}
                  {rows.map((lane, r) =>
                    lane.flatMap((b) =>
                      // A bar that straddles a weekend becomes several segments, one per
                      // week: the code goes in the widest one, the others stay mute.
                      segments(b, days, axis).map((seg, si, all) => {
                        const widest = all.reduce(
                          (a, c) => (segmentWeight(c, axis) > segmentWeight(a, axis) ? c : a),
                          all[0],
                        );
                        // Fractions shift the ends inside the column: a half-day task
                        // takes half a column, not the whole one.
                        const r0 = rect(seg, axis, DAY_W);
                        const w = Math.max(r0.width - 2, 6);
                        // The content goes in the longest stretch, and only if it fits.
                        const show = seg === widest && w >= W_CODE_MIN;
                        // Every OTHER stretch is a tail of the same card, not a new card:
                        // without saying so it looks like an empty duplicate. Careful:
                        // the main stretch isn't necessarily the first — a card can start
                        // on a Friday with an hour and run through the whole next week.
                        const tail = seg !== widest;
                        return (
                          <div
                            key={`${b.id}-${si}`}
                            role="button"
                            tabIndex={0}
                            draggable
                            className={`timeline-bar ${selected === b.id ? "sel" : ""} ${
                              tail ? "tail" : ""
                            } ${show && w < W_NAME ? "narrow" : ""} ${
                              dragged === b.id ? "dragging" : ""
                            } st-${statusOf(b.id)} ${b.conflict ? "conflict" : ""}`}
                            style={{
                              left: r0.left + 1,
                              width: w,
                              height: CARD_H,
                              top: r * ROW_H + 3,
                              // The progress colour doubles as accent and background tint:
                              // two lines of text on a fully saturated fill are unreadable.
                              ["--status" as string]: STATUS_COLOR[statusOf(b.id)],
                            }}
                            title={`${b.id} · ${b.name}\n${b.epicName}\n${fmtDate(b.from)} → ${fmtDate(b.to)} · ${b.days} days`}
                            onDragStart={(e) => {
                              e.dataTransfer.setData("text/plain", b.id);
                              e.dataTransfer.effectAllowed = "move";
                              setDragged(b.id);
                            }}
                            onDragEnd={() => {
                              setDragged(null);
                              setDevTarget(null);
                            }}
                            onClick={() => setSelected(b.id === selected ? null : b.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setSelected(b.id === selected ? null : b.id);
                              }
                            }}
                          >
                            {tail ? (
                              // The tail carries only the resume mark: the content lives in
                              // the main stretch, repeating it would double up the card.
                              <span className="timeline-tail-mark" aria-hidden>
                                ↳
                              </span>
                            ) : (
                              show && (
                                <>
                                  <span className="timeline-bar-head">
                                    <span className={`timeline-badge lay-${b.layer}`} title={LAYER_NAME[b.layer]}>
                                      {LAYER_BADGE[b.layer]}
                                    </span>
                                    <span className="timeline-bar-id">{b.id}</span>
                                    {w >= W_DAYS && <span className="timeline-bar-days">{fmtDays(b.days)}</span>}
                                  </span>
                                  {/* Below the threshold the name doesn't fit: the day count
                                      takes its place, being the densest thing you can put in
                                      that little space. */}
                                  {w >= W_NAME ? (
                                    <span className="timeline-bar-name">{b.name}</span>
                                  ) : (
                                    <span className="timeline-bar-name mute">{fmtDays(b.days)} days</span>
                                  )}
                                </>
                              )
                            )}
                          </div>
                        );
                      }),
                    ),
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {detail && (
        <div className="timeline-detail">
          <div className="timeline-detail-head">
            <span
              className="timeline-detail-id"
              style={{ background: STATUS_COLOR[statusOf(detail.id)] }}
            >
              {detail.id}
            </span>
            <strong>{detail.name}</strong>
            <button className="mini-btn" onClick={() => setSelected(null)}>
              <Icon name="x" size={13} />
            </button>
          </div>

          <div className="timeline-detail-meta">
            <span>
              <em>Status</em>
              <span className="status-switch">
                {STATUSES.map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    className={`status-btn ${statusOf(detail.id) === st.id ? "active" : ""}`}
                    style={{ ["--status" as string]: st.color }}
                    onClick={() => changeStatus(detail.id, st.id)}
                  >
                    {st.label}
                  </button>
                ))}
              </span>
            </span>
            <span>
              <em>Epic</em>
              {detail.epicName}
            </span>
            {detail.taskName && (
              <span>
                <em>Task</em>
                {detail.taskId} · {detail.taskName}
              </span>
            )}
            <span>
              <em>Layer</em>
              {LAYER_NAME[detail.layer]}
            </span>
            <span>
              <em>Effort</em>
              {detail.days} days over {detail.spanDays} {detail.spanDays === 1 ? "working day" : "working days"}
            </span>
            <span>
              <em>Period</em>
              {fmtDate(detail.from)} → {fmtDate(detail.to)}
            </span>
            <span>
              <em>Assigned to</em>
              <select
                value={detail.dev}
                // Changing developer from the detail panel appends the item to the end of
                // their lane; for an exact position you drag the card.
                onChange={(e) => moveItemTo(detail.id, e.target.value, Number.MAX_SAFE_INTEGER)}
              >
                {config.team.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </span>
            <span>
              <em>Position</em>
              {detail.position + 1} of {(barsPerDev.get(detail.dev) ?? []).length}
            </span>
            {detail.conflict && (
              <span className="timeline-conflict">
                <Icon name="triangle-alert" size={13} />
                placed before the layers it depends on
              </span>
            )}

          </div>

          {detail.description && (
            <p className="timeline-detail-description">{detail.description}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The control strip for the project: progress, pace, and where it all ends up.
 *
 * These are the questions a lead asks looking at the board: how much is left, are we
 * keeping the expected pace, and at the current speed do we overrun or not.
 */
function MetricsBar({ metrics: m }: { metrics: Metrics }) {
  const late = m.drift !== null && m.drift > 0;
  const early = m.drift !== null && m.drift < 0;

  return (
    <div className="metrics">
      <div className="metric progress">
        <span className="metric-label">Progress</span>
        <span className="metric-value">{m.progress}%</span>
        <span className="metric-bar">
          {/* Two segments: closed work solid, work in progress dashed. The rest is to do. */}
          <i className="done" style={{ width: `${pct(m.doneDays, m.totalDays)}%` }} />
          <i className="wip" style={{ width: `${pct(m.wipDays, m.totalDays)}%` }} />
        </span>
        <span className="metric-note">
          {fmtDays(m.doneDays)} of {fmtDays(m.totalDays)} days
        </span>
      </div>

      <div className="metric">
        <span className="metric-label">Item status</span>
        <span className="metric-statuses">
          {STATUSES.map((st) => (
            <span key={st.id} className="metric-chip" style={{ ["--status" as string]: st.color }}>
              <i />
              {m.counts[st.id]} {st.label.toLowerCase()}
            </span>
          ))}
        </span>
      </div>

      <div className="metric">
        <span className="metric-label">Velocity</span>
        <span className="metric-value">
          {m.actualVelocity === null ? "—" : `${fmtDays(m.actualVelocity)} days/d`}
        </span>
        <span className="metric-note">
          planned {m.plannedVelocity} days/d
          {m.efficiency !== null && ` · ${Math.round(m.efficiency * 100)}%`}
        </span>
      </div>

      <div className="metric">
        <span className="metric-label">Days</span>
        <span className="metric-value">
          {m.elapsedDays} / {m.elapsedDays + m.remainingDays}
        </span>
        <span className="metric-note">{m.remainingDays} working days left</span>
      </div>

      <div className={`metric projection ${late ? "ko" : early ? "ok" : ""}`}>
        <span className="metric-label">Expected finish</span>
        <span className="metric-value">
          {m.projectedEnd ? fmtDate(m.projectedEnd) : fmtDate(m.plannedEnd)}
        </span>
        <span className="metric-note">
          {m.phase === "not-started"
            ? `plan: ${fmtDate(m.start)} → ${fmtDate(m.plannedEnd)}`
            : m.drift === null
              ? `plan: ${fmtDate(m.plannedEnd)}`
              : m.drift === 0
                ? "on plan"
                : late
                  ? `${m.drift} days behind`
                  : `${-m.drift} days ahead`}
        </span>
      </div>
    </div>
  );
}

/** Percentage share, guarded against a zero total. */
function pct(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

function ConfigPanel({
  config,
  load,
  onChange,
}: {
  config: TimelineDoc;
  load: Record<string, number>;
  onChange: (fn: (c: TimelineDoc) => TimelineDoc) => void;
}) {
  const addDev = () =>
    onChange((c) => {
      // Sequential id independent of position: removing a dev in the middle must not make
      // the next id collide with one already in use (the lanes reference it).
      let n = c.team.length + 1;
      while (c.team.some((d) => d.id === `dev${n}`)) n++;
      return { ...c, team: [...c.team, { id: `dev${n}`, name: `Developer ${n}` }] };
    });

  const removeDev = (id: string) =>
    onChange((c) => ({
      ...c,
      team: c.team.filter((d) => d.id !== id),
      // The removed developer's lane goes with them; their items get redistributed by the
      // reconciliation on the next render (see lib/lanes.ts).
      lanes: (c.lanes ?? []).filter((x) => x.dev !== id),
    }));

  const patchDev = (id: string, patch: (d: TimelineDev) => TimelineDev) =>
    onChange((c) => ({ ...c, team: c.team.map((d) => (d.id === id ? patch(d) : d)) }));

  return (
    <div className="timeline-config">
      <label className="timeline-field">
        Project start
        <input
          type="date"
          value={config.start_date}
          // A project starts at the beginning of a week: a mid-week date gets pushed to
          // the following Monday, so the value shown is the real one.
          onChange={(e) =>
            e.target.value && onChange((c) => ({ ...c, start_date: mondayOf(e.target.value) }))
          }
        />
        <span className="timeline-hint-inline">Monday</span>
      </label>

      <div className="timeline-team">
        {config.team.map((dev) => (
          <div key={dev.id} className="timeline-dev-card">
            <div className="timeline-dev-card-head">
              <input
                value={dev.name}
                onChange={(e) => patchDev(dev.id, (d) => ({ ...d, name: e.target.value }))}
              />
              <span className="timeline-dev-load">{fmtDays(load[dev.id] ?? 0)} days</span>
              {config.team.length > 1 && (
                <button className="mini-btn" title="remove" onClick={() => removeDev(dev.id)}>
                  <Icon name="trash-2" size={12} />
                </button>
              )}
            </div>
            {(dev.leave ?? []).map((p, i) => (
              <div key={i} className="timeline-leave">
                <input
                  type="date"
                  value={p.from}
                  onChange={(e) =>
                    patchDev(dev.id, (d) => ({
                      ...d,
                      leave: (d.leave ?? []).map((t, j) => (j === i ? { ...t, from: e.target.value } : t)),
                    }))
                  }
                />
                <input
                  type="date"
                  value={p.to}
                  onChange={(e) =>
                    patchDev(dev.id, (d) => ({
                      ...d,
                      leave: (d.leave ?? []).map((t, j) => (j === i ? { ...t, to: e.target.value } : t)),
                    }))
                  }
                />
                <button
                  className="mini-btn"
                  title="remove period"
                  onClick={() =>
                    patchDev(dev.id, (d) => ({
                      ...d,
                      leave: (d.leave ?? []).filter((_, j) => j !== i),
                    }))
                  }
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
            <button
              className="mini-btn timeline-add-leave"
              onClick={() =>
                patchDev(dev.id, (d) => ({
                  ...d,
                  leave: [...(d.leave ?? []), { from: config.start_date, to: config.start_date }],
                }))
              }
            >
              <Icon name="plus" size={11} />
              time off
            </button>
          </div>
        ))}
        <button className="mini-btn timeline-add-dev" onClick={addDev}>
          <Icon name="plus" size={13} />
          developer
        </button>
      </div>

      <p className="timeline-hint">
        The project starts on a Monday; weekends and public holidays are left off the axis.
        Tasks distribute themselves automatically. Drag a card wherever you want in a
        developer's lane: the ones to its right slide along. Click it for the details.
      </p>
    </div>
  );
}
