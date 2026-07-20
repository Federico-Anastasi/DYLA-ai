import { describe, expect, it } from "vitest";
import {
  stack,
  buildAxis,
  dayAtX,
  monthBands,
  weekBands,
  segmentWeight,
  rect,
  segments,
} from "./timelineLayout";
import { Calendar, addDays, type ISODate } from "./calendar";
import { schedule, distribute } from "./lanes";
import { extractItems } from "./items";
import type { EstimateDoc, TimelineDoc } from "../types";

const DAY_W = 140;
const GAP_W = 18;

/** Working days between two dates, exactly as the view builds them. */
function workingDays(from: ISODate, to: ISODate, cal = new Calendar()): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!cal.isHoliday(d)) out.push(d);
  return out;
}

describe("buildAxis", () => {
  it("puts the columns side by side inside a week", () => {
    // Mon 20 - Fri 24 July 2026
    const axis = buildAxis(workingDays("2026-07-20", "2026-07-24"), DAY_W, GAP_W);
    expect(axis.x.get("2026-07-20")).toBe(0);
    expect(axis.x.get("2026-07-24")).toBe(4 * DAY_W);
    expect(axis.breaks).toHaveLength(0);
    expect(axis.width).toBe(5 * DAY_W);
  });

  it("inserts a break where the calendar skips the weekend", () => {
    // Fri 24 -> Mon 27: two non-consecutive columns
    const axis = buildAxis(workingDays("2026-07-24", "2026-07-27"), DAY_W, GAP_W);
    expect(axis.breaks).toEqual([{ key: "2026-07-27", left: DAY_W }]);
    expect(axis.x.get("2026-07-27")).toBe(DAY_W + GAP_W);
  });

  it("does NOT break at a month change between consecutive days", () => {
    // Wed 30 Sep -> Thu 1 Oct 2026: consecutive calendar days, no interruption
    const axis = buildAxis(["2026-09-30", "2026-10-01"], DAY_W, GAP_W);
    expect(axis.breaks).toHaveLength(0);
    expect(axis.x.get("2026-10-01")).toBe(DAY_W);
    expect(axis.blockOf.get("2026-09-30")).toBe(axis.blockOf.get("2026-10-01"));
  });

  it("breaks on mid-week holidays", () => {
    // 1 Nov 2027 falls on a Monday, so Fri 29 Oct -> Tue 2 Nov.
    const axis = buildAxis(workingDays("2027-10-29", "2027-11-02"), DAY_W, GAP_W);
    expect(axis.breaks).toHaveLength(1);
    expect(axis.breaks[0].key).toBe("2027-11-02");
  });

  it("numbers the blocks, separating non-consecutive days", () => {
    const axis = buildAxis(workingDays("2026-07-23", "2026-07-28"), DAY_W, GAP_W);
    expect(axis.blockOf.get("2026-07-23")).toBe(0);
    expect(axis.blockOf.get("2026-07-24")).toBe(0);
    expect(axis.blockOf.get("2026-07-27")).toBe(1);
    expect(axis.blockOf.get("2026-07-28")).toBe(1);
  });

  it("handles an empty axis", () => {
    const axis = buildAxis([], DAY_W, GAP_W);
    expect(axis.width).toBe(0);
    expect(axis.breaks).toHaveLength(0);
  });
});

describe("header bands", () => {
  const days = workingDays("2026-09-28", "2026-10-06");
  const axis = buildAxis(days, DAY_W, GAP_W);

  it("a month covers all of its columns, breaks included", () => {
    const months = monthBands(days, axis, DAY_W, (d) => d.slice(0, 7));
    expect(months.map((m) => m.key)).toEqual(["2026-09", "2026-10"]);
    // September: 28, 29, 30 = 3 contiguous columns
    expect(months[0].width).toBe(3 * DAY_W);
    // October starts right after: no break between 30 Sep and 1 Oct
    expect(months[1].left).toBe(3 * DAY_W);
  });

  it("a week splits ONLY on Monday, never on the first of the month", () => {
    const weeks = weekBands(days, axis, DAY_W, (d) => d);
    // 1 October 2026 is a Thursday: it opens no band.
    expect(weeks.map((w) => w.key)).toEqual(["2026-09-28", "2026-10-05"]);
    expect(weeks[0].width).toBe(5 * DAY_W); // 28, 29, 30 Sep + 1, 2 Oct
  });

  it("every band covers exactly five working days", () => {
    const weeks = weekBands(days, axis, DAY_W, (d) => d);
    // The last one may be partial (the project ends mid-week).
    for (const w of weeks.slice(0, -1)) expect(w.width).toBe(5 * DAY_W);
  });

  it("the bands are contiguous: no gaps and no overlaps", () => {
    const weeks = weekBands(days, axis, DAY_W, (d) => d);
    for (let i = 1; i < weeks.length; i++) {
      const prevEnd = weeks[i - 1].left + weeks[i - 1].width;
      const gap = weeks[i].left - prevEnd;
      // Either flush against each other, or separated by exactly one break.
      expect([0, GAP_W]).toContain(gap);
    }
  });
});

// The inverse of the position: the drop handler needs it to know which day the card landed on.
describe("dayAtX", () => {
  const days = workingDays("2026-07-20", "2026-07-28");
  const axis = buildAxis(days, DAY_W, GAP_W);

  it("maps the centre of each column onto its day", () => {
    expect(dayAtX(axis, days, DAY_W / 2, DAY_W)).toBe("2026-07-20");
    expect(dayAtX(axis, days, DAY_W * 2.5, DAY_W)).toBe("2026-07-22");
  });

  it("the column edges belong to the right day", () => {
    expect(dayAtX(axis, days, 0, DAY_W)).toBe("2026-07-20");
    expect(dayAtX(axis, days, DAY_W - 1, DAY_W)).toBe("2026-07-20");
    expect(dayAtX(axis, days, DAY_W, DAY_W)).toBe("2026-07-21");
  });

  it("an x inside a break goes to the day work resumes on", () => {
    const monday = axis.x.get("2026-07-27")!;
    expect(dayAtX(axis, days, monday - GAP_W / 2, DAY_W)).toBe("2026-07-27");
  });

  it("outside the edges it returns the first or the last day", () => {
    expect(dayAtX(axis, days, -50, DAY_W)).toBe("2026-07-20");
    expect(dayAtX(axis, days, 999999, DAY_W)).toBe("2026-07-28");
  });

  it("returns nothing on an empty axis", () => {
    expect(dayAtX(buildAxis([], DAY_W, GAP_W), [], 10, DAY_W)).toBeNull();
  });
});

describe("segments", () => {
  const days = workingDays("2026-07-20", "2026-07-31");
  const axis = buildAxis(days, DAY_W, GAP_W);

  it("stays a single segment within the same week", () => {
    const segs = segments(
      { from: "2026-07-20", to: "2026-07-22", startOffset: 0, endOffset: 1 },
      days,
      axis,
    );
    expect(segs).toHaveLength(1);
  });

  it("splits in two across the weekend", () => {
    const segs = segments(
      { from: "2026-07-23", to: "2026-07-28", startOffset: 0, endOffset: 1 },
      days,
      axis,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ from: "2026-07-23", to: "2026-07-24" });
    expect(segs[1]).toMatchObject({ from: "2026-07-27", to: "2026-07-28" });
  });

  it("carries the fractions only on the first and last run", () => {
    const segs = segments(
      { from: "2026-07-23", to: "2026-07-28", startOffset: 0.5, endOffset: 0.25 },
      days,
      axis,
    );
    expect(segs[0].start).toBe(0.5);
    expect(segs[0].end).toBe(1); // the first run closes at end of day
    expect(segs[1].start).toBe(0); // the second one restarts in the morning
    expect(segs[1].end).toBe(0.25);
  });

  it("no segment crosses a break", () => {
    const segs = segments(
      { from: "2026-07-20", to: "2026-07-31", startOffset: 0, endOffset: 1 },
      days,
      axis,
    );
    for (const seg of segs) {
      const r = rect(seg, axis, DAY_W);
      for (const br of axis.breaks) {
        expect(r.left < br.left + GAP_W && r.left + r.width > br.left).toBe(false);
      }
    }
  });
});

describe("rect", () => {
  const days = workingDays("2026-07-20", "2026-07-24");
  const axis = buildAxis(days, DAY_W, GAP_W);

  it("a full day takes a whole column", () => {
    const r = rect({ from: "2026-07-20", to: "2026-07-20", start: 0, end: 1 }, axis, DAY_W);
    expect(r).toEqual({ left: 0, width: DAY_W });
  });

  it("half a day takes half a column", () => {
    const r = rect({ from: "2026-07-20", to: "2026-07-20", start: 0, end: 0.5 }, axis, DAY_W);
    expect(r).toEqual({ left: 0, width: DAY_W / 2 });
  });

  it("the afternoon starts halfway across the column", () => {
    const r = rect({ from: "2026-07-20", to: "2026-07-20", start: 0.5, end: 1 }, axis, DAY_W);
    expect(r).toEqual({ left: DAY_W / 2, width: DAY_W / 2 });
  });

  it("weight and width agree", () => {
    const seg = { from: "2026-07-20" as ISODate, to: "2026-07-22" as ISODate, start: 0.5, end: 0.5 };
    expect(segmentWeight(seg, axis)).toBe(2);
    expect(rect(seg, axis, DAY_W).width).toBe(2 * DAY_W);
  });
});

describe("stack", () => {
  const bar = (from: string, to: string, startOffset: number, endOffset: number) => ({
    from, to, startOffset, endOffset,
  });

  it("puts morning and afternoon on the same row", () => {
    const rows = stack([
      bar("2026-07-20", "2026-07-20", 0, 0.5),
      bar("2026-07-20", "2026-07-20", 0.5, 1),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
  });

  it("stacks two genuinely overlapping bars", () => {
    const rows = stack([
      bar("2026-07-20", "2026-07-21", 0, 1),
      bar("2026-07-20", "2026-07-20", 0, 1),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("reuses the row for bars in sequence", () => {
    const rows = stack([
      bar("2026-07-20", "2026-07-20", 0, 1),
      bar("2026-07-21", "2026-07-21", 0, 1),
      bar("2026-07-22", "2026-07-22", 0, 1),
    ]);
    expect(rows).toHaveLength(1);
  });
});

// The backstop check: on a real plan no bar may land out of place.
describe("invariants on a full plan", () => {
  const estimate: EstimateDoc = {
    meta: { project: "p", title: "T", date: "2026-08-31", contingency_pct: 15 },
    epics: [1, 2, 3].map((n) => ({
      id: `E${n}`,
      name: `${n}. Epic`,
      tasks: [
        {
          id: `E${n}.T1`,
          task: "T",
          days: 4.25,
          description: "",
          dev_tasks: [
            { id: `E${n}.T1.D1`, dev_task: "a", description: "", days: 0.5, layer: 1 as const },
            { id: `E${n}.T1.D2`, dev_task: "b", description: "", days: 1.75, layer: 2 as const },
            { id: `E${n}.T1.D3`, dev_task: "c", description: "", days: 2, layer: 3 as const },
          ],
        },
      ],
      e2e: { label: "E2E test", days: 0.75 },
    })),
  };
  const config: TimelineDoc = {
    meta: { project: "p", date: "2026-08-31" },
    start_date: "2026-09-28", // straddles the month change, the case that used to be broken
    team: [
      { id: "d1", name: "A" },
      { id: "d2", name: "B" },
    ],
  };

  const plan = schedule(estimate, config, distribute(extractItems(estimate), config.team.map((d) => d.id)));
  const cal = new Calendar();
  const days = workingDays(plan.from, plan.to, cal);
  const axis = buildAxis(days, DAY_W, GAP_W);

  it("every bar fits inside the axis", () => {
    for (const bar of plan.bars) {
      const segs = segments(bar, days, axis);
      expect(segs.length).toBeGreaterThan(0);
      for (const seg of segs) {
        const r = rect(seg, axis, DAY_W);
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.left + r.width).toBeLessThanOrEqual(axis.width + 0.001);
        expect(r.width).toBeGreaterThan(0);
      }
    }
  });

  it("no bar crosses a break", () => {
    for (const bar of plan.bars) {
      for (const seg of segments(bar, days, axis)) {
        const r = rect(seg, axis, DAY_W);
        for (const br of axis.breaks) {
          expect(r.left < br.left + GAP_W - 0.001 && r.left + r.width > br.left + 0.001).toBe(false);
        }
      }
    }
  });

  it("the total width of a bar matches its days", () => {
    for (const bar of plan.bars) {
      const total = segments(bar, days, axis).reduce((a, s) => a + segmentWeight(s, axis), 0);
      expect(total).toBeCloseTo(bar.days, 5);
    }
  });

  it("the bars of one developer never overlap", () => {
    for (const dev of config.team) {
      const own = plan.bars.filter((b: { dev: string }) => b.dev === dev.id);
      expect(stack(own)).toHaveLength(1);
    }
  });

  it("the plan does not skip the month change", () => {
    // Between 30 Sep and 1 Oct there must be no break: they are consecutive.
    if (days.includes("2026-09-30") && days.includes("2026-10-01")) {
      expect(axis.breaks.map((b) => b.key)).not.toContain("2026-10-01");
      expect(axis.x.get("2026-10-01")! - axis.x.get("2026-09-30")!).toBe(DAY_W);
    }
  });

  it("there are exactly as many breaks as calendar jumps", () => {
    const jumps = days.filter((d, i) => i > 0 && addDays(days[i - 1], 1) !== d);
    expect(axis.breaks.map((b) => b.key)).toEqual(jumps);
  });
});
