// Timeline geometry: from a list of working days to pixel positions.
//
// It lives outside the component because this is where the bugs that are hard to spot by
// eye nest (breaks in the wrong place, misaligned bars, text spilling over): kept separate
// and pure, it is covered by tests instead of by visual inspection.

import { addDays, type ISODate } from "./calendar";

export type Axis = {
  /** X position of the left edge of every day. */
  x: Map<ISODate, number>;
  /** Running index of the day on the axis (0-based). */
  index: Map<ISODate, number>;
  /** Which block a day belongs to: consecutive calendar days share a block. */
  blockOf: Map<ISODate, number>;
  /** Breaks to draw: one for every interruption in the calendar. */
  breaks: { key: ISODate; left: number }[];
  width: number;
};

export type Band = { key: string; label: string; left: number; width: number };

export type Segment = { from: ISODate; to: ISODate; start: number; end: number };

/**
 * Lays the working days out on the axis.
 *
 * The break (`gapW`) goes ONLY where the calendar really jumps, that is where the previous
 * day is not the calendar day immediately before: a weekend or a holiday. A month change
 * between two consecutive days is not a jump and must produce no break at all, otherwise it
 * looks like days went by that never existed.
 */
export function buildAxis(days: ISODate[], dayW: number, gapW: number): Axis {
  const x = new Map<ISODate, number>();
  const index = new Map<ISODate, number>();
  const blockOf = new Map<ISODate, number>();
  const breaks: { key: ISODate; left: number }[] = [];
  let cursor = 0;
  let block = 0;

  days.forEach((d, i) => {
    if (i > 0 && addDays(days[i - 1], 1) !== d) {
      breaks.push({ key: d, left: cursor });
      block++;
      cursor += gapW;
    }
    index.set(d, i);
    x.set(d, cursor);
    blockOf.set(d, block);
    cursor += dayW;
  });

  return { x, index, blockOf, breaks, width: cursor };
}

/** Month bands at the top of the grid: one per month the plan crosses. */
export function monthBands(
  days: ISODate[],
  axis: Axis,
  dayW: number,
  label: (d: ISODate) => string,
): Band[] {
  const out: Band[] = [];
  for (const d of days) {
    const left = axis.x.get(d)!;
    const key = d.slice(0, 7); // YYYY-MM
    const last = out[out.length - 1];
    if (last?.key === key) last.width = left + dayW - last.left;
    else out.push({ key, label: label(d), left, width: dayW });
  }
  return out;
}

/**
 * Week bands: they change ONLY on Mondays.
 *
 * They do not split on the first of the month: an October 1st falling on a Thursday is not
 * the start of a week, and treating it as one produces 2-day bands that correspond to
 * nothing. The month is already shown by the band above.
 */
export function weekBands(
  days: ISODate[],
  axis: Axis,
  dayW: number,
  label: (d: ISODate) => string,
): Band[] {
  const out: Band[] = [];
  for (const d of days) {
    const left = axis.x.get(d)!;
    const isNew = out.length === 0 || new Date(`${d}T00:00:00Z`).getUTCDay() === 1;
    if (!isNew) out[out.length - 1].width = left + dayW - out[out.length - 1].left;
    else out.push({ key: d, label: label(d), left, width: dayW });
  }
  return out;
}

/**
 * Splits a bar into runs of consecutive calendar days, keeping the day fractions in mind:
 * `start` and `end` are the shares taken up on the first and last day of the run (0 = start
 * of the morning, 1 = end of the day).
 *
 * Without the split, a bar running from Friday to Monday would cover the break with a solid
 * rectangle, making it look like people work on Saturday and Sunday.
 */
export function segments(
  bar: { from: ISODate; to: ISODate; startOffset: number; endOffset: number },
  days: ISODate[],
  axis: Axis,
): Segment[] {
  const first = axis.index.get(bar.from);
  const last = axis.index.get(bar.to);
  if (first === undefined || last === undefined) return [];

  const out: Segment[] = [];
  for (const d of days.slice(first, last + 1)) {
    const cur = out[out.length - 1];
    if (cur && axis.blockOf.get(d) === axis.blockOf.get(cur.to)) cur.to = d;
    else out.push({ from: d, to: d, start: 0, end: 1 });
  }
  if (out.length) {
    out[0].start = bar.startOffset;
    out[out.length - 1].end = bar.endOffset;
  }
  return out;
}

/**
 * The day a horizontal position falls on: it is the inverse of `x`, and the drag & drop drop
 * handler needs it to work out where the user released the card.
 *
 * An x landing inside a break (the weekend) belongs to no day: it gets assigned to the next
 * working day, which is where the work would resume. Outside the edges it returns the first
 * or the last day of the axis.
 */
export function dayAtX(axis: Axis, days: ISODate[], px: number, dayW: number): ISODate | null {
  if (days.length === 0) return null;
  if (px < 0) return days[0];

  for (const d of days) {
    const left = axis.x.get(d)!;
    if (px < left) return d; // px fell in the break preceding this day
    if (px < left + dayW) return d;
  }
  return days[days.length - 1];
}

/** Pixel rectangle of a segment. */
export function rect(seg: Segment, axis: Axis, dayW: number) {
  const left = axis.x.get(seg.from)! + seg.start * dayW;
  const right = axis.x.get(seg.to)! + seg.end * dayW;
  return { left, width: right - left };
}

/** Person-days covered by a segment: used to pick where to print the code. */
export function segmentWeight(seg: Segment, axis: Axis): number {
  return axis.index.get(seg.to)! - axis.index.get(seg.from)! + seg.end - seg.start;
}

/**
 * Spreads one developer's bars over rows that do not overlap.
 *
 * Two tasks on the same day taking up different fractions (morning / afternoon) sit on the
 * same row. With automatic assignment a developer's bars are always disjoint, but a manual
 * override can make two of them overlap: instead of drawing one on top of the other, they
 * get stacked.
 */
export function stack<T extends { from: ISODate; to: ISODate; startOffset: number; endOffset: number }>(
  bars: T[],
): T[][] {
  const sorted = [...bars].sort(
    (a, b) => a.from.localeCompare(b.from) || a.startOffset - b.startOffset,
  );
  const out: T[][] = [];
  for (const bar of sorted) {
    const free = out.find((row) => {
      const prev = row[row.length - 1];
      return prev.to < bar.from || (prev.to === bar.from && prev.endOffset <= bar.startOffset + 1e-6);
    });
    if (free) free.push(bar);
    else out.push([bar]);
  }
  return out.length ? out : [[]];
}
