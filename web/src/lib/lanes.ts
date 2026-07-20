// The plan as CONTAINERS: every developer owns an ordered queue of items, and that queue
// is the truth. There is no algorithm reordering things behind the user's back.
//
// Three clean-cut operations, deliberately kept apart:
//
//   distribute()  one-off, fills the queues from scratch while respecting the layers
//   moveItem()        drag & drop: a splice between two arrays, nothing more
//   schedule()    the rendering pass: walks the queues and lays them out on the calendar
//
// A developer's capacity is one person-day per workable day (5 days in a full week).
// Items follow one another with no gaps: the next one starts where the previous one
// ended, even halfway through a day.

import { Calendar, addDays, mondayOf, type ISODate } from "./calendar";
import type { EstimateDoc, TimelineDoc } from "../types";
import { extractItems, type PlanItem } from "./items";

/** One queue: the developer and the items, in the order they will be worked on. */
export type Lane = { dev: string; items: string[] };

export type Bar = PlanItem & {
  dev: string;
  from: ISODate;
  to: ISODate;
  spanDays: number;
  startOffset: number;
  endOffset: number;
  /** Position within its developer's queue. */
  position: number;
  /** Starts before an earlier layer of its own epic is finished. */
  conflict: boolean;
};

export type Plan = {
  bars: Bar[];
  from: ISODate;
  to: ISODate;
  loadPerDev: Record<string, number>;
  /** Items that exist in the estimate but sit in no queue at all. */
  unplanned: PlanItem[];
};

const EPS = 1e-6;

/**
 * Plain codepoint order, matching Python's default string comparison (used by
 * server/lanes.py's `sorted(..., key=...)`). `String.localeCompare()` is locale-sensitive —
 * collation rules differ by ICU data/environment, so two machines (or the same machine on
 * two locales) could order the same ids differently. Ids here are ASCII ("E2.T3.D1"), so
 * plain `<`/`>` (UTF-16 code unit order) is exactly codepoint order and needs no library.
 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─────────────────────────────────────────── initial distribution

/**
 * Fills the queues from scratch, balancing the load and respecting the layers.
 *
 * This is the only point where the system decides anything: from here on the queues
 * belong to the user. Items are sorted by epic and layer (so the data model comes before
 * the interfaces, which come before the logic) and handed out to the least loaded
 * developer in turn.
 */
export function distribute(items: PlanItem[], devs: string[]): Lane[] {
  const lanes: Lane[] = devs.map((dev) => ({ dev, items: [] }));
  if (devs.length === 0) return lanes;

  const load = new Map(devs.map((d) => [d, 0]));
  const sorted = [...items].sort(
    (a, b) => a.layer - b.layer || cmp(a.epicId, b.epicId) || cmp(a.id, b.id),
  );

  for (const item of sorted) {
    // Least loaded, and on a tie the first one: the result does not depend on read order.
    let picked = 0;
    for (let i = 1; i < lanes.length; i++) {
      if ((load.get(devs[i]) ?? 0) < (load.get(devs[picked]) ?? 0)) picked = i;
    }
    lanes[picked].items.push(item.id);
    load.set(devs[picked], (load.get(devs[picked]) ?? 0) + item.days);
  }
  return lanes;
}

/**
 * Realigns the queues with the current estimate and team, preserving the order chosen by
 * hand.
 *
 * This is what keeps the plan usable when the estimate changes underneath it: items that
 * disappeared drop out, new ones join the least loaded developer at the back, and the
 * queues of removed developers get redistributed. Nothing the user had already arranged
 * gets reordered.
 */
export function reconcile(lanes: Lane[], items: PlanItem[], devs: string[]): Lane[] {
  const days = new Map(items.map((i) => [i.id, i.days]));
  const known = new Set(items.map((i) => i.id));

  // A dev id should only ever appear once in `lanes`, but if it somehow doesn't (a manually
  // edited timeline.json, say), the two engines must not silently disagree on which entry
  // wins — the board and the exported spreadsheet would put the same work on different
  // people. Both keep the FIRST: if a developer somehow has two lanes, the first is the one
  // that was there, and the rest are the accident. The twin is `setdefault` in
  // server/lanes.py::reconcile — change one and you have to change the other.
  const byDev = new Map<string, string[]>();
  for (const l of lanes) if (!byDev.has(l.dev)) byDev.set(l.dev, l.items);
  const out: Lane[] = devs.map((dev) => ({
    dev,
    items: (byDev.get(dev) ?? []).filter((id) => known.has(id)),
  }));
  if (devs.length === 0) return out;

  const placed = new Set(out.flatMap((l) => l.items));
  const load = new Map(
    out.map((l) => [l.dev, l.items.reduce((a, id) => a + (days.get(id) ?? 0), 0)]),
  );

  // Homeless items: the brand new ones, and those that sat on a developer who is gone.
  const orphans = items.filter((i) => !placed.has(i.id));
  for (const item of orphans) {
    let picked = 0;
    for (let i = 1; i < out.length; i++) {
      if ((load.get(out[i].dev) ?? 0) < (load.get(out[picked].dev) ?? 0)) picked = i;
    }
    out[picked].items.push(item.id);
    load.set(out[picked].dev, (load.get(out[picked].dev) ?? 0) + item.days);
  }
  return out;
}

// ─────────────────────────────────────────── drag & drop

/**
 * Moves an item into the `targetDev` queue at index `position`.
 *
 * It is a splice between two arrays and nothing else: the items after the insertion point
 * shift by one, everything else stays exactly where it was. When moving within the same
 * queue the position is understood AFTER removing the item from its old slot, otherwise
 * dragging a card one step to the right would not move it at all.
 */
export function moveItem(
  lanes: Lane[],
  itemId: string,
  targetDev: string,
  position: number,
): Lane[] {
  const without = lanes.map((l) => ({ dev: l.dev, items: l.items.filter((id) => id !== itemId) }));
  return without.map((l) =>
    l.dev !== targetDev
      ? l
      : {
          dev: l.dev,
          items: [
            ...l.items.slice(0, clamp(position, 0, l.items.length)),
            itemId,
            ...l.items.slice(clamp(position, 0, l.items.length)),
          ],
        },
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

// ─────────────────────────────────────────── laying out on the calendar

/**
 * Lays the queues out on the calendar: every item starts where the previous one in the
 * same queue ended, skipping the days that developer does not work.
 *
 * Time flows in fractions of a day, so two half-day items land on the same day and a full
 * week is worth exactly 5 days of work.
 */
export function schedule(estimate: EstimateDoc, config: TimelineDoc, lanes: Lane[]): Plan {
  const items = extractItems(estimate);
  const byId = new Map(items.map((i) => [i.id, i]));
  const cal = new Calendar(config.holidays ?? [], config.team);
  const start = mondayOf(config.start_date);

  const bars: Bar[] = [];
  const load: Record<string, number> = {};
  const endOf = new Map<string, ISODate>();

  for (const lane of lanes) {
    let day = cal.nextWorkable(lane.dev, start);
    let fraction = 0;
    load[lane.dev] = 0;

    lane.items.forEach((id, position) => {
      const item = byId.get(id);
      if (!item) return; // item gone from the estimate: reconciliation will drop it

      const begin = { day, fraction };
      const end = advance(cal, lane.dev, day, fraction, item.days);

      let spanDays = 1;
      for (let d = begin.day; d < end.day; ) {
        d = cal.nextWorkable(lane.dev, addDays(d, 1));
        spanDays++;
      }

      bars.push({
        ...item,
        dev: lane.dev,
        from: begin.day,
        to: end.day,
        spanDays,
        startOffset: begin.fraction,
        endOffset: end.fraction,
        position,
        conflict: false, // computed below, once every end date is known
      });
      endOf.set(item.id, end.day);
      load[lane.dev] += item.days;

      // The next item picks up right here: no gaps inside the queue.
      if (end.fraction >= 1 - EPS) {
        day = cal.nextWorkable(lane.dev, addDays(end.day, 1));
        fraction = 0;
      } else {
        day = end.day;
        fraction = end.fraction;
      }
    });
  }

  // A conflict moves nothing: it only flags that the chosen order starts an item before
  // an earlier layer of its own epic is finished.
  const byEpic = new Map<string, PlanItem[]>();
  for (const item of items) {
    const group = byEpic.get(item.epicId) ?? [];
    group.push(item);
    byEpic.set(item.epicId, group);
  }
  for (const bar of bars) {
    bar.conflict = (byEpic.get(bar.epicId) ?? [])
      .filter((o) => o.layer < bar.layer)
      .some((o) => {
        const end = endOf.get(o.id);
        return end === undefined || end > bar.from;
      });
  }

  const assigned = new Set(bars.map((b) => b.id));
  return {
    bars,
    ...span(bars, start),
    loadPerDev: load,
    unplanned: items.filter((i) => !assigned.has(i.id)),
  };
}

/** Advances by `days` person-days, skipping the days `dev` cannot work. */
function advance(
  cal: Calendar,
  dev: string,
  day: ISODate,
  fraction: number,
  days: number,
): { day: ISODate; fraction: number } {
  let d = cal.nextWorkable(dev, day);
  let f = fraction;
  let left = Math.max(days, EPS); // a 0-day item still takes up an instant

  for (let i = 0; i < 3660; i++) {
    const available = 1 - f;
    if (left <= available + EPS) return { day: d, fraction: f + left };
    left -= available;
    d = cal.nextWorkable(dev, addDays(d, 1));
    f = 0;
  }
  return { day: d, fraction: 1 };
}

function span(bars: Bar[], start: ISODate): { from: ISODate; to: ISODate } {
  if (bars.length === 0) return { from: start, to: start };
  return {
    from: bars.reduce((a, b) => (a < b.from ? a : b.from), bars[0].from),
    to: bars.reduce((a, b) => (a > b.to ? a : b.to), bars[0].to),
  };
}
