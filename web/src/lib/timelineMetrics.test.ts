import { describe, expect, it } from "vitest";
import { computeMetrics, workingDays } from "./timelineMetrics";
import { Calendar } from "./calendar";
import type { Bar } from "./lanes";
import type { TimelineDoc } from "../types";

const MON = "2026-07-20"; // a Monday
const FRI = "2026-07-24";

function bar(id: string, days: number, dev = "d1"): Bar {
  return {
    id, name: id, description: "", days, layer: 3,
    epicId: "E1", epicName: "1. E", taskId: "E1.T1", taskName: "T",
    dev, from: MON, to: MON, spanDays: 1, startOffset: 0, endOffset: 1,
    position: 0, conflict: false,
  };
}

function config(states: TimelineDoc["states"] = [], nDev = 2): TimelineDoc {
  return {
    meta: { project: "p", date: MON },
    start_date: MON,
    team: Array.from({ length: nDev }, (_, i) => ({ id: `d${i + 1}`, name: `Dev ${i + 1}` })),
    states,
  };
}

const PLAN = { from: MON, to: FRI };

describe("workingDays", () => {
  const cal = new Calendar();

  it("counts a full week as 5", () => {
    expect(workingDays(cal, MON, FRI)).toBe(5);
  });

  it("excludes weekends and holidays", () => {
    expect(workingDays(cal, MON, "2026-07-27")).toBe(6); // Mon-Fri plus Mon
    expect(workingDays(cal, "2026-08-14", "2026-08-17")).toBe(2); // 15 Aug excluded
  });

  it("returns 0 when the range is reversed", () => {
    expect(workingDays(cal, FRI, MON)).toBe(0);
  });
});

describe("computeMetrics", () => {
  const bars = [bar("E1.T1.D1", 4), bar("E1.T1.D2", 4), bar("E1.T1.D3", 2)];

  it("before the start date the project reads as not started", () => {
    const m = computeMetrics(bars, config(), PLAN, "2026-07-13");
    expect(m.phase).toBe("not-started");
    expect(m.elapsedDays).toBe(0);
    expect(m.actualVelocity).toBeNull();
    expect(m.progress).toBe(0);
  });

  it("before the start the remaining days are the whole planned duration", () => {
    // It must not count the days between today and the go-live: those are not project days.
    const m = computeMetrics(bars, config(), PLAN, "2026-06-01");
    expect(m.remainingDays).toBe(5); // Mon-Fri, the planned duration
    expect(m.elapsedDays).toBe(0);
  });

  it("sums the days per status, with todo as the default", () => {
    const m = computeMetrics(
      bars,
      config([{ dev_task_id: "E1.T1.D1", status: "done" }, { dev_task_id: "E1.T1.D2", status: "wip" }]),
      PLAN,
      "2026-07-22",
    );
    expect(m.totalDays).toBe(10);
    expect(m.doneDays).toBe(4);
    expect(m.wipDays).toBe(4);
    expect(m.todoDays).toBe(2);
    expect(m.counts).toEqual({ todo: 1, wip: 1, done: 1 });
  });

  it("counts tasks in progress as half towards completion", () => {
    const m = computeMetrics(
      bars,
      config([{ dev_task_id: "E1.T1.D1", status: "done" }, { dev_task_id: "E1.T1.D2", status: "wip" }]),
      PLAN,
      "2026-07-22",
    );
    // (4 done + 4/2 wip) / 10 = 60%
    expect(m.progress).toBe(60);
  });

  it("planned velocity is one day of work per developer per day", () => {
    expect(computeMetrics(bars, config([], 3), PLAN, "2026-07-22").plannedVelocity).toBe(3);
  });

  it("actual velocity is closed days over elapsed working days", () => {
    // Wednesday = 3 working days (Mon, Tue, Wed); 4 days closed -> 1.33 per day
    const m = computeMetrics(
      bars,
      config([{ dev_task_id: "E1.T1.D1", status: "done" }]),
      PLAN,
      "2026-07-22",
    );
    expect(m.elapsedDays).toBe(3);
    expect(m.actualVelocity).toBeCloseTo(1.33, 2);
    expect(m.efficiency).toBeCloseTo(0.67, 2); // across 2 devs
  });

  it("projects the end at the actual pace and measures the delay", () => {
    // 3 days in, 2 closed -> 0.67 per day; 8 left -> 12 working days.
    const m = computeMetrics(
      [bar("E1.T1.D1", 2), bar("E1.T1.D2", 8)],
      config([{ dev_task_id: "E1.T1.D1", status: "done" }]),
      PLAN,
      "2026-07-22",
    );
    expect(m.projectedEnd).not.toBeNull();
    expect(m.projectedEnd! > PLAN.to).toBe(true);
    expect(m.drift).toBeGreaterThan(0); // running late
  });

  it("signals being ahead with a negative drift", () => {
    // 1 day in, 9 of 10 closed: a blistering pace, finishing well before Friday.
    const m = computeMetrics(
      [bar("E1.T1.D1", 9), bar("E1.T1.D2", 1)],
      config([{ dev_task_id: "E1.T1.D1", status: "done" }]),
      PLAN,
      MON,
    );
    expect(m.drift).toBeLessThanOrEqual(0);
  });

  it("projects nothing when nothing has been closed", () => {
    const m = computeMetrics(bars, config(), PLAN, "2026-07-22");
    expect(m.actualVelocity).toBe(0);
    expect(m.projectedEnd).toBeNull();
    expect(m.drift).toBeNull();
  });

  it("recognises a finished project", () => {
    const m = computeMetrics(
      bars,
      config(bars.map((b) => ({ dev_task_id: b.id, status: "done" as const }))),
      PLAN,
      "2026-07-22",
    );
    expect(m.phase).toBe("finished");
    expect(m.progress).toBe(100);
    expect(m.todoDays).toBe(0);
  });

  it("elapsed days never run past the planned end", () => {
    const m = computeMetrics(bars, config(), PLAN, "2026-09-01");
    expect(m.elapsedDays).toBe(5); // the whole planned week, no more
    expect(m.remainingDays).toBe(0);
  });

  it("handles a plan with no items", () => {
    const m = computeMetrics([], config(), PLAN, "2026-07-22");
    expect(m.totalDays).toBe(0);
    expect(m.progress).toBe(0);
    expect(m.counts).toEqual({ todo: 0, wip: 0, done: 0 });
  });
});
