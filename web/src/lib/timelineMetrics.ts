// Project progress metrics: how much is done, at what pace, and where that pace lands the
// project if it holds.
//
// A pure module ("today" comes in as a parameter, not from Date.now): what the board shows
// is exactly what the tests check.

import { Calendar, type ISODate } from "./calendar";
import type { Bar } from "./lanes";
import type { ItemStatus, TimelineDoc } from "../types";

export type Metrics = {
  /** The project has not started yet, is running, or is over. */
  phase: "not-started" | "in-progress" | "finished";

  totalDays: number;
  doneDays: number;
  wipDays: number;
  todoDays: number;
  /** Percentage complete, 0-100. */
  progress: number;

  /** Items per status, for the board counters. */
  counts: Record<ItemStatus, number>;

  /** Days of work the team can deliver per day: one per developer. */
  plannedVelocity: number;
  /** Days of work actually closed per day so far. null if the project has not started. */
  actualVelocity: number | null;
  /** actualVelocity / plannedVelocity. null if the project has not started. */
  efficiency: number | null;

  /** Working days from the start to today (capped at the planned end). */
  elapsedDays: number;
  /** Working days from today to the planned end. */
  remainingDays: number;

  /** Estimated end at the actual pace. null when there is no pace to measure yet. */
  projectedEnd: ISODate | null;
  /** Working days between the projection and the plan: positive = late. */
  drift: number | null;

  /** End date as planned. */
  plannedEnd: ISODate;
  start: ISODate;
};

/** Working days (for the whole team) between two dates, both ends included. */
export function workingDays(cal: Calendar, from: ISODate, to: ISODate): number {
  if (to < from) return 0;
  let n = 0;
  for (let d = from; d <= to; d = nextDay(d)) if (!cal.isHoliday(d)) n++;
  return n;
}

function nextDay(d: ISODate): ISODate {
  const date = new Date(`${d}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Computes the project metrics.
 *
 * `today` is a parameter because the same function serves the board (current date) and the
 * tests (fixed dates). Days in progress count as half towards completion: an open task is
 * neither zero nor one, and treating it as finished inflates the progress figure.
 */
export function computeMetrics(
  bars: Bar[],
  config: TimelineDoc,
  plan: { from: ISODate; to: ISODate },
  today: ISODate,
): Metrics {
  const cal = new Calendar(config.holidays ?? [], config.team);
  const states = new Map((config.states ?? []).map((s) => [s.dev_task_id, s.status]));
  const statusOf = (id: string): ItemStatus => states.get(id) ?? "todo";

  const totalDays = sum(bars.map((b) => b.days));
  const doneDays = sum(bars.filter((b) => statusOf(b.id) === "done").map((b) => b.days));
  const wipDays = sum(bars.filter((b) => statusOf(b.id) === "wip").map((b) => b.days));
  const todoDays = round2(totalDays - doneDays - wipDays);

  const counts: Record<ItemStatus, number> = { todo: 0, wip: 0, done: 0 };
  for (const b of bars) counts[statusOf(b.id)]++;

  const phase: Metrics["phase"] =
    today < plan.from ? "not-started" : doneDays >= totalDays - 1e-6 ? "finished" : "in-progress";

  // Completion weighs open tasks at half: it is the most honest convention available without
  // asking the user for a percentage on every single item.
  const progress = totalDays > 0 ? round2(((doneDays + wipDays / 2) / totalDays) * 100) : 0;

  const plannedVelocity = config.team.length;
  // For counting purposes "now" stays inside the project window: before the start it is the
  // start, after the end it is the end. Without this, a project kicking off in two months
  // would count the days before the go-live as "remaining".
  const upTo = today < plan.from ? plan.from : today < plan.to ? today : plan.to;
  const elapsedDays = phase === "not-started" ? 0 : workingDays(cal, plan.from, upTo);
  const remainingDays =
    phase === "not-started"
      ? workingDays(cal, plan.from, plan.to)
      : today >= plan.to
        ? 0
        : workingDays(cal, nextDay(upTo), plan.to);

  const actualVelocity = elapsedDays > 0 ? round2(doneDays / elapsedDays) : null;
  const efficiency =
    actualVelocity !== null && plannedVelocity > 0
      ? round2(actualVelocity / plannedVelocity)
      : null;

  // Projection: at the measured pace, how many working days the remainder needs. With zero
  // velocity nothing is projected: that is not "never", it is "not measurable".
  let projectedEnd: ISODate | null = null;
  let drift: number | null = null;
  if (actualVelocity !== null && actualVelocity > 0) {
    const left = totalDays - doneDays;
    const needed = Math.ceil(left / actualVelocity);
    projectedEnd = addWorkingDays(cal, upTo, needed);
    drift =
      projectedEnd > plan.to
        ? workingDays(cal, nextDay(plan.to), projectedEnd)
        : -workingDays(cal, nextDay(projectedEnd), plan.to);
  }

  return {
    phase,
    totalDays: round2(totalDays),
    doneDays: round2(doneDays),
    wipDays: round2(wipDays),
    todoDays,
    progress,
    counts,
    plannedVelocity,
    actualVelocity,
    efficiency,
    elapsedDays,
    remainingDays,
    projectedEnd,
    drift,
    plannedEnd: plan.to,
    start: plan.from,
  };
}

/** Advances by `n` working days from `from` (exclusive). */
function addWorkingDays(cal: Calendar, from: ISODate, n: number): ISODate {
  let d = from;
  let left = n;
  // Safety cap (~10 years): a tiny velocity must not block the render.
  for (let i = 0; i < 3660 && left > 0; i++) {
    d = nextDay(d);
    if (!cal.isHoliday(d)) left--;
  }
  return d;
}

/** Days of work come in steps of 0.25: sums have to be brought back to 2 decimals. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sum(v: number[]): number {
  return v.reduce((a, b) => a + b, 0);
}
